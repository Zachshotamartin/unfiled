import { createHash } from "node:crypto";

import {
  AccountExportCaptureSchema,
  AccountExportNoteSchema,
  AccountExportRoutingRuleSchema,
  AccountExportSpaceSchema,
  AccountExportTagSchema,
  noteAttachmentReferences,
  type AccountExportCapture,
  type AccountExportNote,
  type AccountExportRoutingRule,
  type AccountExportSpace,
  type AccountExportTag,
  type EntityId,
  type NoteAttachment
} from "@unfiled/contracts";

import type {
  OwnerExportNote,
  OwnerExportSource
} from "@/server/encryption/encrypted-owner-export-source";

const encoder = new TextEncoder();
const TAR_BLOCK_SIZE = 512;
const MAX_TAR_PATH_BYTES = 255;
const MAX_TAR_PREFIX_BYTES = 155;
const MAX_TAR_NAME_BYTES = 100;

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("The export was cancelled", "AbortError");
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  let output = "";
  let size = 0;
  for (const character of value) {
    const encoded = encoder.encode(character).byteLength;
    if (size + encoded > maximumBytes) break;
    output += character;
    size += encoded;
  }
  return output;
}

export function sanitizeExportPathComponent(value: string, maximumBytes: number): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\\/]+/gu, "-")
    .replace(/[\p{Cc}]+/gu, "-")
    .replace(/[^\p{L}\p{N} ._-]+/gu, "-")
    .replace(/\s+/gu, " ")
    .replace(/^[ .]+|[ .]+$/gu, "")
    .replace(/-+/gu, "-");
  const safe =
    normalized === "" || normalized === "." || normalized === ".." ? "Untitled" : normalized;
  const bounded = truncateUtf8(safe, maximumBytes).replace(/[ .]+$/gu, "");
  return bounded === "" ? "Untitled" : bounded;
}

export function markdownPathForNote(note: OwnerExportNote): string {
  const spaces =
    note.spacePath === null
      ? ["Unfiled"]
      : note.spacePath
          .split(" / ")
          .slice(0, 2)
          .map((part) => sanitizeExportPathComponent(part, 48));
  const title = sanitizeExportPathComponent(note.title, 58);
  return ["Notes", ...spaces, `${title}--${note.id}.md`].join("/");
}

function tarPath(path: string): Readonly<{ name: string; prefix: string }> {
  if (path.startsWith("/") || path.includes("\0") || path.split("/").includes("..")) {
    throw new TypeError("Unsafe export path");
  }
  if (byteLength(path) > MAX_TAR_PATH_BYTES) throw new TypeError("Export path is too long");
  if (byteLength(path) <= MAX_TAR_NAME_BYTES) return { name: path, prefix: "" };
  const separators = [...path.matchAll(/\//gu)].map(({ index }) => index).reverse();
  for (const index of separators) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (byteLength(prefix) <= MAX_TAR_PREFIX_BYTES && byteLength(name) <= MAX_TAR_NAME_BYTES) {
      return { name, prefix };
    }
  }
  throw new TypeError("Export path cannot be represented by ustar");
}

function writeText(target: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = encoder.encode(value);
  if (bytes.byteLength > length) throw new TypeError("Tar field is too long");
  target.set(bytes, offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Invalid tar number");
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length > length - 1) throw new TypeError("Tar number is too large");
  writeText(target, offset, length - 1, encoded);
  target[offset + length - 1] = 0;
}

function tarHeader(path: string, size: number, modifiedAt: string): Uint8Array {
  const { name, prefix } = tarPath(path);
  const header = new Uint8Array(TAR_BLOCK_SIZE);
  writeText(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, Math.floor(Date.parse(modifiedAt) / 1_000));
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeText(header, 257, 6, "ustar\0");
  writeText(header, 263, 2, "00");
  writeText(header, 265, 32, "unfiled");
  writeText(header, 297, 32, "unfiled");
  writeText(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, "0");
  writeText(header, 148, 6, checksumText);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function padding(size: number): Uint8Array | null {
  const length = (TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
  return length === 0 ? null : new Uint8Array(length);
}

function markdownChunks(note: OwnerExportNote): readonly Uint8Array[] {
  const header = encoder.encode(`# ${note.title}\n\n`);
  const body = encoder.encode(note.bodyMarkdown);
  const ending = encoder.encode(note.bodyMarkdown.endsWith("\n") ? "" : "\n");
  return Object.freeze([header, body, ending]);
}

/// The photos and recordings a note body places, in order, each once. The archive reads the same
/// projection the note detail returns, so what the owner downloads matches what they were shown.
export function placedAttachments(bodyMarkdown: string): readonly NoteAttachment[] {
  return noteAttachmentReferences(bodyMarkdown);
}

export function attachmentPath(id: EntityId<"att">, kind: "image" | "audio"): string {
  return `attachments/${id}.${kind === "image" ? "jpg" : "m4a"}`;
}

function manifestNote(note: OwnerExportNote): AccountExportNote {
  return AccountExportNoteSchema.parse({
    id: note.id,
    markdownPath: markdownPathForNote(note),
    spaceId: note.spaceId,
    type: note.type,
    privacy: note.privacy,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    archivedAt: note.archivedAt,
    deletedAt: note.deletedAt,
    tagIds: note.tagIds,
    links: note.links,
    sourceCaptureIds: note.sourceCaptureIds,
    attachments: placedAttachments(note.bodyMarkdown)
  });
}

function manifestPrefix(exportedAt: string): string {
  return `{"schemaVersion":1,"exportedAt":${JSON.stringify(exportedAt)},"spaces":[`;
}

const MANIFEST_SPACES_TO_TAGS = `],"tags":[`;
const MANIFEST_TAGS_TO_NOTES = `],"notes":[`;
const MANIFEST_NOTES_TO_RULES = `],"routingRules":[`;
const MANIFEST_RULES_TO_CAPTURES = `],"captures":[`;
const MANIFEST_SUFFIX = "]}\n";

function fragment(
  value:
    | AccountExportCapture
    | AccountExportNote
    | AccountExportRoutingRule
    | AccountExportSpace
    | AccountExportTag,
  index: number
): string {
  return `${index === 0 ? "" : ","}${JSON.stringify(value)}`;
}

async function* tarArchive(
  source: OwnerExportSource,
  exportedAt: string,
  signal: AbortSignal
): AsyncGenerator<Uint8Array> {
  const prefix = manifestPrefix(exportedAt);
  let manifestSize =
    byteLength(prefix) +
    byteLength(MANIFEST_SPACES_TO_TAGS) +
    byteLength(MANIFEST_TAGS_TO_NOTES) +
    byteLength(MANIFEST_NOTES_TO_RULES) +
    byteLength(MANIFEST_RULES_TO_CAPTURES) +
    byteLength(MANIFEST_SUFFIX);
  const expectedManifestDigest = createHash("sha256");
  expectedManifestDigest.update(prefix);
  let spaceCount = 0;
  for await (const page of source.spacePages()) {
    throwIfAborted(signal);
    for (const spaceValue of page) {
      const space = AccountExportSpaceSchema.parse(spaceValue);
      const serialized = fragment(space, spaceCount);
      manifestSize += byteLength(serialized);
      expectedManifestDigest.update(serialized);
      spaceCount += 1;
    }
  }
  expectedManifestDigest.update(MANIFEST_SPACES_TO_TAGS);
  let tagCount = 0;
  for await (const page of source.tagPages()) {
    throwIfAborted(signal);
    for (const tagValue of page) {
      const tag = AccountExportTagSchema.parse(tagValue);
      const serialized = fragment(tag, tagCount);
      manifestSize += byteLength(serialized);
      expectedManifestDigest.update(serialized);
      tagCount += 1;
    }
  }
  expectedManifestDigest.update(MANIFEST_TAGS_TO_NOTES);
  let noteCount = 0;
  const paths = new Set<string>();

  for await (const page of source.notePages()) {
    throwIfAborted(signal);
    for (const note of page) {
      const record = manifestNote(note);
      const path = record.markdownPath;
      if (paths.has(path)) throw new TypeError("Duplicate export path");
      paths.add(path);
      const serialized = fragment(record, noteCount);
      manifestSize += byteLength(serialized);
      expectedManifestDigest.update(serialized);
      noteCount += 1;

      const chunks = markdownChunks(note);
      const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      yield tarHeader(path, size, note.updatedAt);
      for (const chunk of chunks) {
        throwIfAborted(signal);
        if (chunk.byteLength > 0) yield chunk;
      }
      const tail = padding(size);
      if (tail !== null) yield tail;

      // The photos and recordings this note places travel beside it, each once per archive.
      for (const placed of placedAttachments(note.bodyMarkdown)) {
        throwIfAborted(signal);
        const attachmentFile = attachmentPath(placed.id, placed.kind);
        if (paths.has(attachmentFile)) continue;
        const attachment = await source.attachment(placed.id);
        if (attachment === null) continue;
        paths.add(attachmentFile);
        yield tarHeader(attachmentFile, attachment.bytes.byteLength, note.updatedAt);
        if (attachment.bytes.byteLength > 0) yield attachment.bytes;
        const attachmentTail = padding(attachment.bytes.byteLength);
        if (attachmentTail !== null) yield attachmentTail;
      }
    }
  }

  expectedManifestDigest.update(MANIFEST_NOTES_TO_RULES);
  let ruleCount = 0;
  for await (const page of source.routingRulePages()) {
    throwIfAborted(signal);
    for (const ruleValue of page) {
      const rule = AccountExportRoutingRuleSchema.parse(ruleValue);
      const serialized = fragment(rule, ruleCount);
      manifestSize += byteLength(serialized);
      expectedManifestDigest.update(serialized);
      ruleCount += 1;
    }
  }

  expectedManifestDigest.update(MANIFEST_RULES_TO_CAPTURES);
  let captureCount = 0;
  for await (const page of source.capturePages()) {
    throwIfAborted(signal);
    for (const captureValue of page) {
      const capture = AccountExportCaptureSchema.parse(captureValue);
      const serialized = fragment(capture, captureCount);
      manifestSize += byteLength(serialized);
      expectedManifestDigest.update(serialized);
      captureCount += 1;

      // A capture no note has absorbed holds the only copy of its photos and recordings, so
      // their bytes travel here rather than only under the notes that place them.
      for (const held of capture.attachments) {
        throwIfAborted(signal);
        const attachmentFile = attachmentPath(held.id, held.kind);
        if (paths.has(attachmentFile)) continue;
        const attachment = await source.attachment(held.id);
        if (attachment === null) continue;
        paths.add(attachmentFile);
        yield tarHeader(attachmentFile, attachment.bytes.byteLength, capture.receivedAt);
        if (attachment.bytes.byteLength > 0) yield attachment.bytes;
        const attachmentTail = padding(attachment.bytes.byteLength);
        if (attachmentTail !== null) yield attachmentTail;
      }
    }
  }
  expectedManifestDigest.update(MANIFEST_SUFFIX);
  const expectedDigest = expectedManifestDigest.digest("hex");

  yield tarHeader("manifest.json", manifestSize, exportedAt);
  const actualManifestDigest = createHash("sha256");
  let actualSize = 0;
  let actualSpaces = 0;
  let actualTags = 0;
  let actualNotes = 0;
  let actualRules = 0;
  let actualCaptures = 0;
  const emitManifest = (value: string): Uint8Array => {
    const bytes = encoder.encode(value);
    actualSize += bytes.byteLength;
    actualManifestDigest.update(value);
    return bytes;
  };

  yield emitManifest(prefix);
  for await (const page of source.spacePages()) {
    throwIfAborted(signal);
    for (const spaceValue of page) {
      yield emitManifest(fragment(AccountExportSpaceSchema.parse(spaceValue), actualSpaces));
      actualSpaces += 1;
    }
  }
  yield emitManifest(MANIFEST_SPACES_TO_TAGS);
  for await (const page of source.tagPages()) {
    throwIfAborted(signal);
    for (const tagValue of page) {
      yield emitManifest(fragment(AccountExportTagSchema.parse(tagValue), actualTags));
      actualTags += 1;
    }
  }
  yield emitManifest(MANIFEST_TAGS_TO_NOTES);
  for await (const page of source.notePages()) {
    throwIfAborted(signal);
    for (const note of page) {
      yield emitManifest(fragment(manifestNote(note), actualNotes));
      actualNotes += 1;
    }
  }
  yield emitManifest(MANIFEST_NOTES_TO_RULES);
  for await (const page of source.routingRulePages()) {
    throwIfAborted(signal);
    for (const ruleValue of page) {
      const rule = AccountExportRoutingRuleSchema.parse(ruleValue);
      yield emitManifest(fragment(rule, actualRules));
      actualRules += 1;
    }
  }
  yield emitManifest(MANIFEST_RULES_TO_CAPTURES);
  for await (const page of source.capturePages()) {
    throwIfAborted(signal);
    for (const captureValue of page) {
      yield emitManifest(fragment(AccountExportCaptureSchema.parse(captureValue), actualCaptures));
      actualCaptures += 1;
    }
  }
  yield emitManifest(MANIFEST_SUFFIX);
  const actualDigest = actualManifestDigest.digest("hex");
  if (
    actualSize !== manifestSize ||
    actualSpaces !== spaceCount ||
    actualTags !== tagCount ||
    actualNotes !== noteCount ||
    actualRules !== ruleCount ||
    actualCaptures !== captureCount ||
    actualDigest !== expectedDigest
  ) {
    throw new TypeError("The library changed while the export was being generated");
  }
  const manifestTail = padding(manifestSize);
  if (manifestTail !== null) yield manifestTail;
  yield new Uint8Array(TAR_BLOCK_SIZE * 2);
}

function iterableStream(
  source: AsyncGenerator<Uint8Array>,
  onCancel: () => void,
  onFinalize: () => void
): ReadableStream<Uint8Array> {
  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    onFinalize();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await source.next();
        if (next.done) {
          finalize();
          controller.close();
        } else controller.enqueue(next.value);
      } catch (error) {
        finalize();
        controller.error(error);
      }
    },
    async cancel() {
      onCancel();
      try {
        await source.return(undefined);
      } finally {
        finalize();
      }
    }
  });
}

/** Creates a backpressure-aware tar.gz without filesystem or whole-library plaintext buffers. */
export function createStreamingAccountExport(
  source: OwnerExportSource,
  options: Readonly<{ exportedAt: string; signal?: AbortSignal }>
): ReadableStream<Uint8Array> {
  if (!Number.isFinite(Date.parse(options.exportedAt))) throw new TypeError("Invalid export time");
  const cancellation = new AbortController();
  const parent = options.signal;
  const abort = () => cancellation.abort();
  if (parent?.aborted === true) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const archive = iterableStream(
    tarArchive(source, options.exportedAt, cancellation.signal),
    abort,
    () => parent?.removeEventListener("abort", abort)
  );
  const normalized = archive.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array<ArrayBuffer>>({
      transform(chunk, controller) {
        controller.enqueue(new Uint8Array(chunk));
      }
    })
  );
  return normalized.pipeThrough(new CompressionStream("gzip"));
}
