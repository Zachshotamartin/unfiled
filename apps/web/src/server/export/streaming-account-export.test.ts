import type {
  AccountExportCapture,
  AccountExportRoutingRule,
  AccountExportSpace,
  AccountExportTag,
  EntityId
} from "@unfiled/contracts";
import { describe, expect, it } from "vitest";

import type {
  OwnerExportNote,
  OwnerExportSource
} from "@/server/encryption/encrypted-owner-export-source";

import {
  createStreamingAccountExport,
  markdownPathForNote,
  sanitizeExportPathComponent
} from "./streaming-account-export";

const EXPORTED_AT = "2026-08-31T20:00:00.000Z";
const SPACE_ID = "spc_00000000000000000000000001" as EntityId<"spc">;
const TAG_ID = "tag_00000000000000000000000001" as EntityId<"tag">;

function noteId(index: number): EntityId<"note"> {
  return `note_${index.toString().padStart(26, "0")}`;
}

function note(index: number, title = "Untitled"): OwnerExportNote {
  return {
    id: noteId(index),
    spaceId: SPACE_ID,
    spacePath: "Projects / ../../Escape",
    type: "generic",
    title,
    bodyMarkdown: `body ${index}`,
    privacy: "private_manual",
    createdAt: EXPORTED_AT,
    updatedAt: EXPORTED_AT,
    archivedAt: null,
    deletedAt: null,
    tagIds: [TAG_ID],
    links: [],
    sourceCaptureIds: []
  };
}

const spaces: readonly AccountExportSpace[] = [
  {
    id: SPACE_ID,
    parentId: null,
    name: "Projects",
    path: "Projects",
    archivedAt: null,
    createdAt: EXPORTED_AT,
    updatedAt: EXPORTED_AT
  }
];
const tags: readonly AccountExportTag[] = [
  { id: TAG_ID, name: "Important", createdAt: EXPORTED_AT, updatedAt: EXPORTED_AT }
];
const rules: readonly AccountExportRoutingRule[] = [
  {
    id: "rule_00000000000000000000000001",
    enabled: true,
    ruleType: "prefix",
    condition: "work:",
    normalizedCondition: "work:",
    aliases: ["office"],
    destinationNoteId: null,
    destinationSpaceId: SPACE_ID,
    priority: 10,
    source: "explicit",
    lastFiredAt: null,
    createdAt: EXPORTED_AT,
    updatedAt: EXPORTED_AT
  }
];

function source(
  notes: readonly OwnerExportNote[],
  pageSize = 137,
  attachments: Readonly<Record<string, Uint8Array>> = {},
  captures: readonly AccountExportCapture[] = []
): OwnerExportSource {
  return {
    attachment(id) {
      const bytes = attachments[id];
      return Promise.resolve(
        bytes === undefined ? null : { kind: "image" as const, mediaType: "image/jpeg", bytes }
      );
    },
    async *spacePages() {
      await Promise.resolve();
      yield spaces;
    },
    async *tagPages() {
      await Promise.resolve();
      yield tags;
    },
    async *notePages() {
      await Promise.resolve();
      for (let offset = 0; offset < notes.length; offset += pageSize) {
        yield notes.slice(offset, offset + pageSize);
      }
    },
    async *routingRulePages() {
      await Promise.resolve();
      yield rules;
    },
    async *capturePages() {
      await Promise.resolve();
      if (captures.length > 0) yield captures;
    }
  };
}

async function decompress(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const normalized = stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array<ArrayBuffer>>({
      transform(chunk, controller) {
        controller.enqueue(new Uint8Array(chunk));
      }
    })
  );
  return new Uint8Array(
    await new Response(normalized.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()
  );
}

function tarFiles(bytes: Uint8Array): ReadonlyMap<string, Uint8Array> {
  const decoder = new TextDecoder();
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  const text = (start: number, length: number) =>
    decoder.decode(bytes.slice(start, start + length)).replace(/\0.*$/u, "");
  while (offset + 512 <= bytes.byteLength) {
    const header = bytes.slice(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = text(offset, 100);
    const prefix = text(offset + 345, 155);
    const path = prefix === "" ? name : `${prefix}/${name}`;
    const sizeValue = text(offset + 124, 12).trim();
    const size = Number.parseInt(sizeValue, 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new TypeError("Invalid test tar");
    offset += 512;
    files.set(path, bytes.slice(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

describe("streaming account export", () => {
  it("carries placed photos beside their notes, once per archive, and lists them in the manifest", async () => {
    const photo = "att_01ARZ3NDEKTSV4RRFFQ69G5FAZ";
    const gone = "att_01ARZ3NDEKTSV4RRFFQ69G5FAY";
    const bytes = new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70]);
    const body = [
      "Whiteboard from the kitchen",
      "",
      `![Photo](unfiled-attachment:${photo})`,
      `[Recording](unfiled-attachment:${gone})`
    ].join("\n");
    const notes = [
      { ...note(0), bodyMarkdown: body },
      { ...note(1), bodyMarkdown: `Again\n\n![Photo](unfiled-attachment:${photo})` }
    ];
    const archive = createStreamingAccountExport(source(notes, 137, { [photo]: bytes }), {
      exportedAt: EXPORTED_AT,
      signal: new AbortController().signal
    });
    const files = tarFiles(await decompress(archive));

    expect([...(files.get(`attachments/${photo}.jpg`) ?? [])]).toEqual([...bytes]);
    expect(files.has(`attachments/${gone}.m4a`)).toBe(false);
    expect([...files.keys()].filter((path) => path.startsWith("attachments/"))).toHaveLength(1);
    const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json"))) as {
      notes: readonly { attachments: readonly { id: string; kind: string }[] }[];
    };
    expect(manifest.notes[0]?.attachments).toEqual([
      { id: photo, kind: "image" },
      { id: gone, kind: "audio" }
    ]);
    expect(manifest.notes[1]?.attachments).toEqual([{ id: photo, kind: "image" }]);
  });

  it("carries the captures no note has absorbed, with the photos only they hold", async () => {
    const photo = "att_01ARZ3NDEKTSV4RRFFQ69G5FAX";
    const bytes = new Uint8Array([255, 216, 255, 224, 0, 16, 74, 71]);
    const waiting: AccountExportCapture = {
      id: "cap_01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      rawContent: "the receipt from lunch",
      source: "mobile",
      privacy: "ai_assisted",
      status: "needs_review",
      lastErrorCode: null,
      clientCreatedAt: EXPORTED_AT,
      receivedAt: EXPORTED_AT,
      attachments: [{ id: photo, kind: "image" }]
    };
    const archive = createStreamingAccountExport(source([], 137, { [photo]: bytes }, [waiting]), {
      exportedAt: EXPORTED_AT,
      signal: new AbortController().signal
    });
    const files = tarFiles(await decompress(archive));

    // A capture waiting in Review lives in no note, so the archive is the only place its words
    // and its photo can be; an export without them loses everything the Inbox is holding.
    const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json"))) as {
      captures: readonly AccountExportCapture[];
    };
    expect(manifest.captures).toEqual([waiting]);
    expect([...(files.get(`attachments/${photo}.jpg`) ?? [])]).toEqual([...bytes]);
  });

  it("streams exactly 1,000 notes with collision-safe paths and human-readable taxonomy", async () => {
    const notes = Array.from({ length: 1_000 }, (_, index) => note(index + 1, "Same title"));
    const archive = await decompress(
      createStreamingAccountExport(source(notes), { exportedAt: EXPORTED_AT })
    );
    const files = tarFiles(archive);
    const markdown = [...files.keys()].filter((path) => path.endsWith(".md"));
    expect(markdown).toHaveLength(1_000);
    expect(new Set(markdown).size).toBe(1_000);
    expect(markdown.every((path) => !path.includes("../") && path.startsWith("Notes/"))).toBe(true);

    const manifestBytes = files.get("manifest.json");
    expect(manifestBytes).toBeDefined();
    const manifest: unknown = JSON.parse(new TextDecoder().decode(manifestBytes));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      exportedAt: EXPORTED_AT,
      spaces: [{ id: SPACE_ID, name: "Projects", path: "Projects" }],
      tags: [{ id: TAG_ID, name: "Important" }],
      routingRules: [{ condition: "work:", aliases: ["office"] }]
    });
    expect((manifest as { notes: unknown[] }).notes).toHaveLength(1_000);
    expect(JSON.stringify(manifest)).not.toMatch(
      /wrappedDataKey|keyId|ciphertext|provider[_-]?key/iu
    );
  });

  it("sanitizes traversal, control characters, and platform separators", () => {
    expect(sanitizeExportPathComponent(" ../a\\b/\0c ", 48)).toBe("-a-b-c");
    const path = markdownPathForNote(note(1, "../../secrets"));
    expect(path).not.toContain("../");
    expect(path).toMatch(/--note_[0-9]{26}\.md$/u);
  });

  it("fails closed when any manifest surface changes between streaming passes", async () => {
    let notePass = 0;
    const changing: OwnerExportSource = {
      ...source([]),
      async *notePages() {
        await Promise.resolve();
        notePass += 1;
        yield [note(1, notePass === 1 ? "Before" : "After")];
      }
    };
    await expect(
      new Response(
        createStreamingAccountExport(changing, { exportedAt: EXPORTED_AT })
      ).arrayBuffer()
    ).rejects.toThrow("library changed");
  });

  it("observes cancellation without reading later pages", async () => {
    const controller = new AbortController();
    let pagesRead = 0;
    const cancellable: OwnerExportSource = {
      ...source([]),
      async *notePages() {
        await Promise.resolve();
        pagesRead += 1;
        yield [note(1)];
      }
    };
    controller.abort();
    const reader = createStreamingAccountExport(cancellable, {
      exportedAt: EXPORTED_AT,
      signal: controller.signal
    }).getReader();
    await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
    expect(pagesRead).toBe(0);
  });
});
