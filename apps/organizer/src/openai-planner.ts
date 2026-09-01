import { randomUUID } from "node:crypto";

import { OrganizerPlannerReviewError, OrganizerProviderError } from "./errors.js";
import {
  OPENAI_ORGANIZATION_PLAN_SCHEMA,
  OPENAI_ORGANIZATION_PLAN_SCHEMA_NAME
} from "./openai-schema.js";
import {
  inferOrganizerCaptureKind,
  resolveDeterministicDestination,
  type DeterministicDestinationMatch,
  type OrganizerPlanner,
  type PlannerInput
} from "./planner.js";
import {
  ORGANIZER_PROMPT_VERSION,
  ORGANIZER_ROUTING_PROMPT,
  ORGANIZER_SCHEMA_VERSION
} from "./prompt.js";

const OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
const CAPTURE_ID = /^cap_[0-9A-HJKMNP-TV-Z]{26}$/u;
const NOTE_ID = /^note_[0-9A-HJKMNP-TV-Z]{26}$/u;
const EPHEMERAL_CANDIDATE_ID = /^candidate_[0-9a-f]{32}$/u;
const NOTE_TYPES = new Set(["generic", "list", "log", "principle", "project"]);
const MAX_CAPTURE_CHARACTERS = 10_000;
const MAX_CANDIDATES = 8;
const MAX_CANDIDATE_BODY_CHARACTERS = 200_000;
const MAX_TITLE_CHARACTERS = 200;
const MAX_HEADING_CHARACTERS = 200;
const MAX_SNIPPET_CHARACTERS = 200;
const MAX_USER_INPUT_BYTES = 64 * 1_024;
const MAX_RESPONSE_BYTES = 256 * 1_024;

export const OPENAI_ROUTING_PROFILE = Object.freeze({
  deadlineMs: 20_000,
  maxOutputTokens: 12_288,
  maxRetries: 1,
  model: "gpt-5.4-mini-2026-03-17",
  promptVersion: ORGANIZER_PROMPT_VERSION,
  reasoningEffort: "none",
  schemaVersion: ORGANIZER_SCHEMA_VERSION
} as const);

export type OpenAIOrganizerPlannerOptions = Readonly<{
  apiKey: string;
  fetchImplementation?: typeof fetch;
}>;

type EphemeralCandidateId = `candidate_${string}`;

type ProviderCandidate = Readonly<{
  candidateId: EphemeralCandidateId;
  headings: readonly string[];
  isOpen: true;
  latestSnippet: string;
  noteType: "generic" | "list" | "log" | "principle" | "project";
  title: string;
}>;

type ProviderInput = Readonly<{
  candidates: readonly ProviderCandidate[];
  capture: Readonly<{ inferredKind: string; text: string }>;
  contract: "unfiled.routing.input.v1";
  controls: Readonly<{
    expansionDisabled: boolean;
    explicitDestinationCandidateId: EphemeralCandidateId | null;
  }>;
}>;

type PreparedProviderInput = Readonly<{
  ephemeralToInternalCandidateId: ReadonlyMap<EphemeralCandidateId, string>;
  internalToEphemeralCandidateId: ReadonlyMap<string, EphemeralCandidateId>;
  serialized: string;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function characterLength(value: string): number {
  return Array.from(value).length;
}

function truncateCharacters(value: string, maximum: number, fromEnd = false): string {
  const characters = Array.from(value);
  return (fromEnd ? characters.slice(-maximum) : characters.slice(0, maximum)).join("");
}

function normalizeExcerpt(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function candidateHeadings(bodyMarkdown: string): readonly string[] {
  const headings: string[] = [];
  for (const line of bodyMarkdown.split(/\r?\n/u)) {
    const match = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line);
    const heading = match?.[1] === undefined ? "" : normalizeExcerpt(match[1]);
    if (heading.length > 0) headings.push(truncateCharacters(heading, MAX_HEADING_CHARACTERS));
    if (headings.length === 3) break;
  }
  return Object.freeze(headings);
}

function candidateSnippet(bodyMarkdown: string): string {
  return truncateCharacters(normalizeExcerpt(bodyMarkdown), MAX_SNIPPET_CHARACTERS, true);
}

function inputBoundsFailure(): never {
  throw new OrganizerPlannerReviewError("input_bounds");
}

function createEphemeralCandidateId(seen: ReadonlySet<string>): EphemeralCandidateId {
  for (;;) {
    const candidateId: EphemeralCandidateId = `candidate_${randomUUID().replaceAll("-", "")}`;
    if (!seen.has(candidateId)) return candidateId;
  }
}

function buildProviderInput(
  input: PlannerInput,
  deterministicDestination: DeterministicDestinationMatch | null
): PreparedProviderInput {
  if (
    input.promptVersion !== OPENAI_ROUTING_PROFILE.promptVersion ||
    input.schemaVersion !== OPENAI_ROUTING_PROFILE.schemaVersion
  ) {
    throw new OrganizerProviderError("validation_failed", false);
  }
  if (input.signal.aborted) throw new OrganizerProviderError("provider_unavailable", true);
  if (
    !CAPTURE_ID.test(input.captureId) ||
    typeof input.capture.rawContent !== "string" ||
    characterLength(input.capture.rawContent) < 1 ||
    characterLength(input.capture.rawContent) > MAX_CAPTURE_CHARACTERS ||
    input.candidates.length > MAX_CANDIDATES ||
    input.capture.controls.expansionDisabled !== input.controls.expansionDisabled ||
    input.capture.controls.explicitDestinationNoteId !== input.controls.explicitDestinationNoteId
  ) {
    inputBoundsFailure();
  }

  const seenCandidateIds = new Set<string>();
  const seenNoteIds = new Set<string>();
  const seenEphemeralCandidateIds = new Set<string>();
  const ephemeralToInternalCandidateId = new Map<EphemeralCandidateId, string>();
  const internalToEphemeralCandidateId = new Map<string, EphemeralCandidateId>();
  const candidates: ProviderCandidate[] = [];
  for (const candidate of input.candidates) {
    if (
      !NOTE_ID.test(candidate.candidateId) ||
      !NOTE_ID.test(candidate.noteId) ||
      seenCandidateIds.has(candidate.candidateId) ||
      seenNoteIds.has(candidate.noteId) ||
      !candidate.isOpen ||
      !NOTE_TYPES.has(candidate.noteType) ||
      !Number.isSafeInteger(candidate.revision) ||
      candidate.revision < 1 ||
      typeof candidate.title !== "string" ||
      characterLength(candidate.title.trim()) < 1 ||
      characterLength(candidate.title) > MAX_TITLE_CHARACTERS ||
      typeof candidate.bodyMarkdown !== "string" ||
      characterLength(candidate.bodyMarkdown) > MAX_CANDIDATE_BODY_CHARACTERS
    ) {
      inputBoundsFailure();
    }
    seenCandidateIds.add(candidate.candidateId);
    seenNoteIds.add(candidate.noteId);
    const ephemeralCandidateId = createEphemeralCandidateId(seenEphemeralCandidateIds);
    seenEphemeralCandidateIds.add(ephemeralCandidateId);
    ephemeralToInternalCandidateId.set(ephemeralCandidateId, candidate.candidateId);
    internalToEphemeralCandidateId.set(candidate.candidateId, ephemeralCandidateId);
    candidates.push(
      Object.freeze({
        candidateId: ephemeralCandidateId,
        headings: candidateHeadings(candidate.bodyMarkdown),
        isOpen: true,
        latestSnippet: candidateSnippet(candidate.bodyMarkdown),
        noteType: candidate.noteType,
        title: candidate.title
      })
    );
  }

  const explicitNoteId = input.controls.explicitDestinationNoteId;
  if (explicitNoteId !== null && !NOTE_ID.test(explicitNoteId)) inputBoundsFailure();
  if (explicitNoteId !== null && deterministicDestination?.source !== "explicit_control")
    inputBoundsFailure();

  const explicitDestinationCandidateId =
    deterministicDestination === null
      ? null
      : (internalToEphemeralCandidateId.get(deterministicDestination.candidateId) ?? null);
  if (deterministicDestination !== null && explicitDestinationCandidateId === null)
    inputBoundsFailure();

  const providerInput: ProviderInput = Object.freeze({
    candidates: Object.freeze(candidates),
    capture: Object.freeze({
      inferredKind: inferOrganizerCaptureKind(input.capture.rawContent),
      text: input.capture.rawContent
    }),
    contract: "unfiled.routing.input.v1",
    controls: Object.freeze({
      expansionDisabled: input.controls.expansionDisabled,
      explicitDestinationCandidateId
    })
  });
  const serialized = JSON.stringify(providerInput);
  if (new TextEncoder().encode(serialized).byteLength > MAX_USER_INPUT_BYTES) inputBoundsFailure();
  return Object.freeze({
    ephemeralToInternalCandidateId,
    internalToEphemeralCandidateId,
    serialized
  });
}

function assertApiKey(apiKey: string): void {
  let hasUnsafeCharacter = false;
  for (let index = 0; index < apiKey.length; index += 1) {
    const codeUnit = apiKey.charCodeAt(index);
    if (codeUnit <= 0x20 || codeUnit === 0x7f) hasUnsafeCharacter = true;
  }
  if (apiKey.length < 20 || apiKey.length > 512 || apiKey.trim() !== apiKey || hasUnsafeCharacter) {
    throw new OrganizerProviderError("provider_key_invalid", false);
  }
}

function responseFailure(status: number): OrganizerProviderError {
  if (status === 401 || status === 403)
    return new OrganizerProviderError("provider_key_invalid", false, status);
  if (status === 429) return new OrganizerProviderError("rate_limited", true, status);
  if (status === 408 || status === 409 || status >= 500)
    return new OrganizerProviderError("provider_unavailable", true, status);
  return new OrganizerProviderError("validation_failed", false, status);
}

async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Provider error bodies are deliberately neither retained nor logged.
  }
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.body === null) throw new OrganizerProviderError("provider_unavailable", true, 200);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let readCompleted = false;
  try {
    for (;;) {
      const part = await readStreamPart(reader, signal);
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        part.value.fill(0);
        await reader.cancel();
        throw new OrganizerPlannerReviewError("invalid_output");
      }
      chunks.push(part.value);
    }
    readCompleted = true;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A non-conforming transport may leave a read pending after cancellation.
    }
    if (!readCompleted) for (const chunk of chunks) chunk.fill(0);
  }

  const bytes = new Uint8Array(total);
  try {
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error: unknown) {
    if (error instanceof OrganizerPlannerReviewError) throw error;
    throw new OrganizerProviderError("provider_unavailable", true, 200);
  } finally {
    bytes.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

function readStreamPart(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    return Promise.reject(new OrganizerProviderError("provider_unavailable", true));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", aborted);
    const aborted = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void reader.cancel().catch(() => undefined);
      reject(new OrganizerProviderError("provider_unavailable", true));
    };
    signal.addEventListener("abort", aborted, { once: true });
    void reader.read().then(
      (part) => {
        if (settled) {
          part.value?.fill(0);
          return;
        }
        settled = true;
        cleanup();
        resolve(part);
      },
      () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new OrganizerProviderError("provider_unavailable", true));
      }
    );
  });
}

function parseCompletedResponse(value: unknown): unknown {
  if (!isRecord(value)) throw new OrganizerPlannerReviewError("invalid_output");
  if (value.status === "incomplete" || value.status === "cancelled")
    throw new OrganizerPlannerReviewError("incomplete");
  if (value.status !== "completed")
    throw new OrganizerProviderError("provider_unavailable", true, 200);
  if (!Array.isArray(value.output)) throw new OrganizerPlannerReviewError("invalid_output");

  const outputTexts: string[] = [];
  for (const item of value.output) {
    if (!isRecord(item)) throw new OrganizerPlannerReviewError("invalid_output");
    if (item.type === "reasoning") continue;
    if (item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content))
      throw new OrganizerPlannerReviewError("invalid_output");
    for (const content of item.content) {
      if (!isRecord(content)) throw new OrganizerPlannerReviewError("invalid_output");
      if (content.type === "refusal") throw new OrganizerPlannerReviewError("refusal");
      if (content.type !== "output_text" || typeof content.text !== "string")
        throw new OrganizerPlannerReviewError("invalid_output");
      outputTexts.push(content.text);
    }
  }
  if (outputTexts.length !== 1) throw new OrganizerPlannerReviewError("invalid_output");
  try {
    const plan = JSON.parse(outputTexts[0] ?? "") as unknown;
    if (!isRecord(plan)) throw new OrganizerPlannerReviewError("invalid_output");
    return plan;
  } catch (error: unknown) {
    if (error instanceof OrganizerPlannerReviewError) throw error;
    throw new OrganizerPlannerReviewError("invalid_output");
  }
}

function enforceDeterministicDestination(
  plan: unknown,
  destinationCandidateId: EphemeralCandidateId | null
): unknown {
  if (destinationCandidateId === null || !isRecord(plan) || plan.decision !== "append_to_note")
    return plan;
  return Object.freeze({
    ...plan,
    destination: Object.freeze({ candidateId: destinationCandidateId, newNote: null })
  });
}

function translateCandidateId(
  value: unknown,
  ephemeralToInternalCandidateId: ReadonlyMap<EphemeralCandidateId, string>
): string {
  if (typeof value !== "string" || !EPHEMERAL_CANDIDATE_ID.test(value))
    throw new OrganizerPlannerReviewError("invalid_output");
  const internalCandidateId = ephemeralToInternalCandidateId.get(value as EphemeralCandidateId);
  if (internalCandidateId === undefined) throw new OrganizerPlannerReviewError("invalid_output");
  return internalCandidateId;
}

function translateProviderCandidateIds(
  plan: unknown,
  ephemeralToInternalCandidateId: ReadonlyMap<EphemeralCandidateId, string>
): unknown {
  if (!isRecord(plan)) throw new OrganizerPlannerReviewError("invalid_output");

  let destination = plan.destination;
  if (isRecord(destination) && destination.candidateId !== null) {
    destination = Object.freeze({
      ...destination,
      candidateId: translateCandidateId(destination.candidateId, ephemeralToInternalCandidateId)
    });
  }

  let alternatives = plan.alternatives;
  if (Array.isArray(alternatives)) {
    alternatives = Object.freeze(
      alternatives.map((candidateId) =>
        translateCandidateId(candidateId, ephemeralToInternalCandidateId)
      )
    );
  }

  let operations = plan.operations;
  if (Array.isArray(operations)) {
    const providerOperations: readonly unknown[] = operations;
    operations = Object.freeze(
      providerOperations.map((operation) => {
        if (!isRecord(operation) || operation.type !== "add_relation") return operation;
        return Object.freeze({
          ...operation,
          toCandidateId: translateCandidateId(
            operation.toCandidateId,
            ephemeralToInternalCandidateId
          )
        });
      })
    );
  }

  return Object.freeze({ ...plan, alternatives, destination, operations });
}

function fetchWithAbort(
  fetchImplementation: typeof fetch,
  body: string,
  apiKey: string,
  signal: AbortSignal
): Promise<Response> {
  if (signal.aborted)
    return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const aborted = (): void => {
      if (settled) return;
      settled = true;
      reject(new DOMException("The operation was aborted", "AbortError"));
    };
    signal.addEventListener("abort", aborted, { once: true });
    void fetchImplementation(OPENAI_RESPONSES_ENDPOINT, {
      body,
      cache: "no-store",
      credentials: "omit",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      method: "POST",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal
    }).then(
      (response) => {
        signal.removeEventListener("abort", aborted);
        if (settled || signal.aborted) {
          settled = true;
          void discardResponse(response);
          return;
        }
        settled = true;
        resolve(response);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        if (settled) return;
        settled = true;
        reject(
          error instanceof Error ? error : new OrganizerProviderError("provider_unavailable", true)
        );
      }
    );
  });
}

function requestBody(userInput: string): string {
  return JSON.stringify({
    background: false,
    input: [
      {
        content: [{ text: userInput, type: "input_text" }],
        role: "user"
      }
    ],
    instructions: ORGANIZER_ROUTING_PROMPT,
    max_output_tokens: OPENAI_ROUTING_PROFILE.maxOutputTokens,
    model: OPENAI_ROUTING_PROFILE.model,
    parallel_tool_calls: false,
    reasoning: { effort: OPENAI_ROUTING_PROFILE.reasoningEffort },
    store: false,
    stream: false,
    text: {
      format: {
        name: OPENAI_ORGANIZATION_PLAN_SCHEMA_NAME,
        schema: OPENAI_ORGANIZATION_PLAN_SCHEMA,
        strict: true,
        type: "json_schema"
      }
    },
    tool_choice: "none",
    tools: [],
    truncation: "disabled"
  });
}

function retryable(error: unknown, attempt: number, signal: AbortSignal): boolean {
  if (attempt >= OPENAI_ROUTING_PROFILE.maxRetries || signal.aborted) return false;
  if (error instanceof OrganizerPlannerReviewError) return false;
  return !(error instanceof OrganizerProviderError) || error.retryable;
}

function networkFailure(error: unknown): OrganizerProviderError | OrganizerPlannerReviewError {
  if (error instanceof OrganizerProviderError || error instanceof OrganizerPlannerReviewError)
    return error;
  return new OrganizerProviderError("provider_unavailable", true);
}

export function createOpenAIOrganizerPlanner(
  options: OpenAIOrganizerPlannerOptions
): OrganizerPlanner {
  assertApiKey(options.apiKey);
  const fetchImplementation = options.fetchImplementation ?? fetch;
  return Object.freeze({
    async plan(input): Promise<unknown> {
      const deterministicDestination = resolveDeterministicDestination({
        candidates: input.candidates,
        capture: input.capture
      });
      const preparedInput = buildProviderInput(input, deterministicDestination);
      const deterministicEphemeralCandidateId =
        deterministicDestination === null
          ? null
          : (preparedInput.internalToEphemeralCandidateId.get(
              deterministicDestination.candidateId
            ) ?? null);
      if (deterministicDestination !== null && deterministicEphemeralCandidateId === null)
        inputBoundsFailure();
      const body = requestBody(preparedInput.serialized);
      const deadline = AbortSignal.timeout(OPENAI_ROUTING_PROFILE.deadlineMs);
      const signal = AbortSignal.any([input.signal, deadline]);
      let attempt = 0;
      for (;;) {
        try {
          const response = await fetchWithAbort(fetchImplementation, body, options.apiKey, signal);
          if (!response.ok) {
            const failure = responseFailure(response.status);
            await discardResponse(response);
            throw failure;
          }
          const parsed = parseCompletedResponse(await readBoundedJson(response, signal));
          if (signal.aborted) throw new OrganizerProviderError("provider_unavailable", true);
          return translateProviderCandidateIds(
            enforceDeterministicDestination(parsed, deterministicEphemeralCandidateId),
            preparedInput.ephemeralToInternalCandidateId
          );
        } catch (error: unknown) {
          const safe = networkFailure(error);
          if (!retryable(safe, attempt, signal)) throw safe;
          attempt += 1;
        }
      }
    }
  });
}
