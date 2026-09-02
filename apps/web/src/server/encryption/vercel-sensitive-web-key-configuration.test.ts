import { describe, expect, it } from "vitest";

import { ConfigurationError } from "@/server/api/errors";

import {
  parseVercelSensitiveWebKeyConfiguration,
  VERCEL_SENSITIVE_WEB_CUSTODIAN_MODE,
  VERCEL_SENSITIVE_WEB_ROOT_REGISTRY_VARIABLE
} from "./vercel-sensitive-web-key-configuration";

const PROJECT_ID = "prj_UnfiledWeb123456";
const PAIRS = [
  ["ai_assisted", "object_wrap"],
  ["ai_assisted", "content_mac"],
  ["private_manual", "object_wrap"],
  ["private_manual", "content_mac"]
] as const;

type KeyClass = (typeof PAIRS)[number][0];
type KeyPurpose = (typeof PAIRS)[number][1];
type RootStatus = "active" | "retired" | "staged";
interface RegistryEntry {
  generation: number;
  keyClass: KeyClass;
  purpose: KeyPurpose;
  rootKeyId: string;
  status: RootStatus;
}
interface Registry {
  version: 2;
  custodyProvider: "vercel_sensitive_environment_v1";
  projectId: string;
  deploymentEnvironment: "production";
  roots: Record<string, RegistryEntry>;
}

function rootKeyId(pairIndex: number, generation: number): string {
  const suffix = String(pairIndex * 1_000 + generation).padStart(12, "0");
  return `urn:unfiled:key-root:vercel-sensitive-env-v1:production:00000000-0000-4000-8000-${suffix}`;
}

function registryId(keyClass: KeyClass, purpose: KeyPurpose, generation: number): string {
  return `${keyClass}_${purpose}_v${generation}`;
}

function entry(
  keyClass: KeyClass,
  purpose: KeyPurpose,
  generation: number,
  status: RootStatus,
  id = rootKeyId(
    PAIRS.findIndex(
      ([candidateClass, candidatePurpose]) =>
        candidateClass === keyClass && candidatePurpose === purpose
    ),
    generation
  )
): RegistryEntry {
  return { generation, keyClass, purpose, rootKeyId: id, status };
}

function registry(generation = 1): Registry {
  return {
    version: 2,
    custodyProvider: "vercel_sensitive_environment_v1",
    projectId: PROJECT_ID,
    deploymentEnvironment: "production",
    roots: Object.fromEntries(
      PAIRS.map(([keyClass, purpose]) => [
        registryId(keyClass, purpose, generation),
        entry(keyClass, purpose, generation, "active")
      ])
    )
  };
}

function environment(document: Registry | string = registry()): Record<string, string | undefined> {
  return {
    NODE_ENV: "production",
    UNFILED_KEY_CUSTODIAN: VERCEL_SENSITIVE_WEB_CUSTODIAN_MODE,
    VERCEL: "1",
    VERCEL_ENV: "production",
    VERCEL_PROJECT_ID: PROJECT_ID,
    [VERCEL_SENSITIVE_WEB_ROOT_REGISTRY_VARIABLE]:
      typeof document === "string" ? document : JSON.stringify(document)
  };
}

function clone(value: Registry): Registry {
  return structuredClone(value);
}

function requiredEntry(value: Registry, id: string): RegistryEntry {
  const found = value.roots[id];
  if (found === undefined) throw new Error(`Missing fixture ${id}`);
  return found;
}

function expectFailure(value: Readonly<Record<string, string | undefined>>): void {
  expect(() => parseVercelSensitiveWebKeyConfiguration(value)).toThrow(ConfigurationError);
}

describe("Vercel sensitive-environment web key configuration", () => {
  it("derives exact active, retired, and complete transport root sets", () => {
    const document = clone(registry(2));
    for (const [pairIndex, [keyClass, purpose]] of PAIRS.entries()) {
      document.roots[registryId(keyClass, purpose, 1)] = entry(keyClass, purpose, 1, "retired");
      document.roots[registryId(keyClass, purpose, 3)] = entry(keyClass, purpose, 3, "staged");
      expect(rootKeyId(pairIndex, 2)).toContain(":production:");
    }

    const result = parseVercelSensitiveWebKeyConfiguration(environment(document));

    expect(result.activeRoots).toEqual({
      ai_assisted: {
        content_mac: rootKeyId(1, 2),
        object_wrap: rootKeyId(0, 2)
      },
      private_manual: {
        content_mac: rootKeyId(3, 2),
        object_wrap: rootKeyId(2, 2)
      }
    });
    expect(result.retiredRoots).toEqual({
      ai_assisted: {
        content_mac: [rootKeyId(1, 1)],
        object_wrap: [rootKeyId(0, 1)]
      },
      private_manual: {
        content_mac: [rootKeyId(3, 1)],
        object_wrap: [rootKeyId(2, 1)]
      }
    });
    expect(result.expectedRootKeyIds).toEqual(
      Object.values(document.roots).map(({ rootKeyId: id }) => id)
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.activeRoots.ai_assisted)).toBe(true);
    expect(Object.isFrozen(result.retiredRoots.private_manual?.object_wrap)).toBe(true);
  });

  it.each([
    ["Preview", { VERCEL_ENV: "preview" }],
    ["Development", { NODE_ENV: "development" }],
    ["non-Vercel", { VERCEL: "0" }],
    ["missing project", { VERCEL_PROJECT_ID: undefined }],
    ["padded project", { VERCEL_PROJECT_ID: `${PROJECT_ID} ` }],
    ["wrong mode", { UNFILED_KEY_CUSTODIAN: "local" }]
  ] as const)("rejects %s identity", (_label, override) => {
    expectFailure({ ...environment(), ...override });
  });

  it("binds registry metadata to the exact Vercel project and Production environment", () => {
    const wrongProject = clone(registry());
    wrongProject.projectId = "prj_Different123456";
    expectFailure(environment(wrongProject));

    const previewRoot = clone(registry());
    previewRoot.roots.ai_assisted_object_wrap_v1 = {
      ...requiredEntry(previewRoot, "ai_assisted_object_wrap_v1"),
      rootKeyId:
        "urn:unfiled:key-root:vercel-sensitive-env-v1:preview:00000000-0000-4000-8000-000000000001"
    };
    expectFailure(environment(previewRoot));
  });

  it("requires canonical, exact, versioned metadata without duplicate JSON properties", () => {
    const exact = JSON.stringify(registry());
    expectFailure(environment(` ${exact}`));
    expectFailure(environment(JSON.stringify({ ...registry(), extra: true })));
    expectFailure(environment(exact.replace('"version":2', '"version":2,"version":2')));
    expectFailure(environment(exact.replace("vercel_sensitive_environment_v1", "aws_kms_v1")));
    expectFailure(environment(exact.replace('"version":2', '"version":1')));
  });

  it("requires exactly one active root per class and purpose with ordered lifecycle generations", () => {
    const missing = clone(registry());
    delete missing.roots.ai_assisted_object_wrap_v1;

    const duplicateActive = clone(registry());
    duplicateActive.roots.ai_assisted_object_wrap_v2 = entry(
      "ai_assisted",
      "object_wrap",
      2,
      "active"
    );

    const staleStaged = clone(registry(2));
    staleStaged.roots.ai_assisted_object_wrap_v1 = entry("ai_assisted", "object_wrap", 1, "staged");

    const futureRetired = clone(registry());
    futureRetired.roots.ai_assisted_object_wrap_v2 = entry(
      "ai_assisted",
      "object_wrap",
      2,
      "retired"
    );

    const duplicateStaged = clone(registry());
    duplicateStaged.roots.ai_assisted_object_wrap_v2 = entry(
      "ai_assisted",
      "object_wrap",
      2,
      "staged"
    );
    duplicateStaged.roots.ai_assisted_object_wrap_v3 = entry(
      "ai_assisted",
      "object_wrap",
      3,
      "staged"
    );

    for (const document of [
      missing,
      duplicateActive,
      staleStaged,
      futureRetired,
      duplicateStaged
    ]) {
      expectFailure(environment(document));
    }
  });

  it("rejects duplicate roots, duplicate generation metadata, malformed IDs, and excessive history", () => {
    const duplicateRoot = clone(registry());
    duplicateRoot.roots.private_manual_content_mac_v1 = {
      ...requiredEntry(duplicateRoot, "private_manual_content_mac_v1"),
      rootKeyId: requiredEntry(duplicateRoot, "ai_assisted_object_wrap_v1").rootKeyId
    };

    const duplicateGeneration = clone(registry());
    duplicateGeneration.roots.ai_assisted_object_wrap_alias = entry(
      "ai_assisted",
      "object_wrap",
      1,
      "retired",
      rootKeyId(0, 99)
    );

    const malformed = clone(registry());
    malformed.roots.ai_assisted_object_wrap_v1 = {
      ...requiredEntry(malformed, "ai_assisted_object_wrap_v1"),
      rootKeyId: "root-key"
    };

    const tooManyRetired = clone(registry());
    delete tooManyRetired.roots.ai_assisted_object_wrap_v1;
    tooManyRetired.roots.ai_assisted_object_wrap_v22 = entry(
      "ai_assisted",
      "object_wrap",
      22,
      "active"
    );
    for (let generation = 1; generation <= 21; generation += 1) {
      tooManyRetired.roots[registryId("ai_assisted", "object_wrap", generation)] = entry(
        "ai_assisted",
        "object_wrap",
        generation,
        "retired"
      );
    }

    for (const document of [duplicateRoot, duplicateGeneration, malformed, tooManyRetired]) {
      expectFailure(environment(document));
    }
  });

  it("bounds the canonical registry by encoded bytes", () => {
    expectFailure(
      environment({
        ...registry(),
        roots: {
          ...registry().roots,
          ["x".repeat(66_000)]: entry("ai_assisted", "object_wrap", 2, "retired")
        }
      })
    );
  });
});
