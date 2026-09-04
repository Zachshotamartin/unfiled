"use client";

import type { NoteSummary, RoutingRuleDto, RoutingRuleType, Space } from "@unfiled/contracts";
import { type SyntheticEvent, useMemo, useRef, useState } from "react";

import {
  browserApi,
  isAmbiguousProductMutationFailure,
  isStaleRevision,
  productErrorMessage
} from "@/lib/product/browser-api";
import { announceProductChange, createIdempotencyKey } from "@/lib/product/client";
import {
  emptyRoutingRuleDraft,
  ROUTING_RULE_TYPE_COPY,
  routingRuleAcceptRequest,
  routingRuleCreateFields,
  routingRuleDraftErrors,
  routingRuleDraftFor,
  routingRuleIdempotencyKeyForAttempt,
  isRoutableRoutingRuleNote,
  routingRuleLastFiredLabel,
  routingRuleRemovalRequest,
  routingRuleSourceLabel,
  routingRuleStateLabel,
  routingRuleToggleRequest,
  routingRuleUpdateFields,
  boundedRoutingRulePreviewText,
  previewRoutingRuleMatch,
  ROUTING_RULE_PREVIEW_MAX_CODE_POINTS,
  reconcileAuthoritativeRoutingRules,
  sortRoutingRules,
  upsertRoutingRuleWithoutRevisionRegression
} from "@/lib/product/routing-rules";
import type { RoutingRuleMutationAttempt } from "@/lib/product/routing-rules";
import type { RoutingRuleDraft } from "@/lib/product/types";
import { useLiveResource } from "@/lib/product/use-live-resource";
import { usePagedResource } from "@/lib/product/use-paged-resource";

import { EmptyState, ResourceError } from "./resource-states";
import { UnfiledGlyph } from "./unfiled-glyph";

type RoutingRuleFilter = "all" | "active" | "blocked" | "paused" | "suggested";
type EditorSelection = "new" | RoutingRuleDto | null;

const ruleTypeOptions = Object.entries(ROUTING_RULE_TYPE_COPY) as readonly (readonly [
  RoutingRuleType,
  (typeof ROUTING_RULE_TYPE_COPY)[RoutingRuleType]
])[];

function entityKey(value: Readonly<{ id: string }>): string {
  return value.id;
}

type RoutingRuleSnapshot = Readonly<{ items: readonly RoutingRuleDto[] }>;

function loadRoutingRules(): Promise<RoutingRuleSnapshot> {
  return browserApi.listAllRoutingRules();
}

function isReplayedMutation(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    "replayed" in value &&
    (value as Readonly<{ replayed?: unknown }>).replayed === true
  );
}

function destinationId(rule: RoutingRuleDto): string {
  return rule.destination.type === "note" ? rule.destination.noteId : rule.destination.spaceId;
}

function destinationLabel(
  rule: RoutingRuleDto,
  notes: readonly NoteSummary[],
  spaces: readonly Space[]
): string {
  if (rule.destinationStatus !== "active") {
    const status =
      rule.destinationStatus === "archived"
        ? "Archived"
        : rule.destinationStatus === "deleted"
          ? "Deleted"
          : "Missing";
    return `${status} ${rule.destination.type}`;
  }
  if (rule.destination.type === "note") {
    const noteId = rule.destination.noteId;
    const note = notes.find((candidate) => candidate.id === noteId);
    return note === undefined ? "Note destination" : note.title;
  }
  const spaceId = rule.destination.spaceId;
  const space = spaces.find((candidate) => candidate.id === spaceId);
  return space === undefined ? "Space destination" : space.name;
}

function matchesFilter(rule: RoutingRuleDto, filter: RoutingRuleFilter): boolean {
  switch (filter) {
    case "active":
      return rule.enabled && rule.destinationStatus === "active";
    case "blocked":
      return rule.destinationStatus !== "active";
    case "paused":
      return (
        !rule.enabled && rule.proposalState !== "offered" && rule.destinationStatus === "active"
      );
    case "suggested":
      return rule.proposalState === "offered";
    case "all":
      return true;
  }
}

function RoutingRulesSkeleton() {
  return (
    <div className="routing-rule-list" aria-busy="true" aria-label="Loading routing rules">
      {[0, 1].map((row) => (
        <div className="routing-rule-row" key={row} aria-hidden="true">
          <div>
            <div className="skeleton-block h-3 w-24" />
            <div className="skeleton-block mt-4 h-6 w-52 max-w-[75%]" />
            <div className="skeleton-block mt-3 h-4 w-36" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function RoutingRuleEditor({
  destinationError,
  notes,
  notesHasMore,
  notesLoading,
  notesLoadingMore,
  onCancel,
  onLoadMoreNotes,
  onLoadMoreSpaces,
  onSave,
  pending,
  rule,
  spaces,
  spacesHasMore,
  spacesLoading,
  spacesLoadingMore
}: Readonly<{
  destinationError: string | null;
  notes: readonly NoteSummary[];
  notesHasMore: boolean;
  notesLoading: boolean;
  notesLoadingMore: boolean;
  onCancel: () => void;
  onLoadMoreNotes: () => void;
  onLoadMoreSpaces: () => void;
  onSave: (draft: RoutingRuleDraft) => Promise<void>;
  pending: boolean;
  rule: RoutingRuleDto | null;
  spaces: readonly Space[];
  spacesHasMore: boolean;
  spacesLoading: boolean;
  spacesLoadingMore: boolean;
}>) {
  const [draft, setDraft] = useState<RoutingRuleDraft>(() =>
    rule === null ? emptyRoutingRuleDraft() : routingRuleDraftFor(rule)
  );
  const [submitted, setSubmitted] = useState(false);
  const errors = routingRuleDraftErrors(draft);
  const prefix = rule === null ? "new-routing-rule" : `routing-rule-${rule.id}`;
  const routableNotes = notes.filter(isRoutableRoutingRuleNote);
  const activeSpaces = spaces.filter((space) => space.archivedAt === null);
  const options = draft.destinationKind === "note" ? routableNotes : activeSpaces;
  const hasMore = draft.destinationKind === "note" ? notesHasMore : spacesHasMore;
  const loadingOptions = draft.destinationKind === "note" ? notesLoading : spacesLoading;
  const loadingMore = draft.destinationKind === "note" ? notesLoadingMore : spacesLoadingMore;
  const currentDestinationId = rule === null ? null : destinationId(rule);
  const currentDestinationKnownIneligible =
    draft.destinationKind === "note" &&
    notes.some((note) => note.id === currentDestinationId && !isRoutableRoutingRuleNote(note));
  const currentDestinationMissing =
    rule !== null &&
    rule.destinationStatus === "active" &&
    draft.destinationKind === rule.destination.type &&
    !currentDestinationKnownIneligible &&
    !options.some((option) => option.id === currentDestinationId);
  const destinationIsSelectable =
    options.some((option) => option.id === draft.destinationId) ||
    (currentDestinationMissing && draft.destinationId === currentDestinationId);
  const canSave =
    Object.keys(errors).length === 0 &&
    destinationIsSelectable &&
    (rule === null || routingRuleUpdateFields(rule, draft) !== null);

  function update(patch: Partial<RoutingRuleDraft>): void {
    setDraft((current) => Object.freeze({ ...current, ...patch }));
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitted(true);
    if (!canSave) return;
    await onSave(draft);
  }

  return (
    <section className="routing-rule-editor" aria-labelledby={`${prefix}-heading`}>
      <header className="routing-rule-editor-header">
        <div>
          <p className="section-label">{rule === null ? "New instruction" : "Edit rule"}</p>
          <h3 id={`${prefix}-heading`}>
            {rule === null ? "Route a familiar jot" : "Update this routing rule"}
          </h3>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Close routing rule editor"
          disabled={pending}
          onClick={onCancel}
        >
          <UnfiledGlyph glyph="close" size={17} weight={1.9} />
        </button>
      </header>

      {rule !== null && rule.destinationStatus !== "active" ? (
        <div className="routing-rule-warning" role="status">
          <UnfiledGlyph glyph="warning" size={18} weight={1.9} />
          <p>This destination is {rule.destinationStatus}. Choose an active replacement to save.</p>
        </div>
      ) : null}

      <form onSubmit={(event) => void submit(event)} noValidate>
        <div className="routing-rule-form-grid">
          <div className="routing-rule-condition-field">
            <label className="field-label" htmlFor={`${prefix}-condition`}>
              Matching text
            </label>
            <input
              id={`${prefix}-condition`}
              className="editor-control mt-2"
              value={draft.condition}
              maxLength={500}
              autoComplete="off"
              aria-describedby={`${prefix}-condition-help ${prefix}-condition-error`}
              aria-invalid={submitted && errors.condition !== undefined ? true : undefined}
              onChange={(event) => update({ condition: event.target.value })}
            />
            <p id={`${prefix}-condition-help`} className="routing-rule-field-help">
              {ROUTING_RULE_TYPE_COPY[draft.ruleType].helper}
            </p>
            <p id={`${prefix}-condition-error`} className="routing-rule-field-error" role="alert">
              {submitted ? errors.condition : null}
            </p>
          </div>

          <div>
            <label className="field-label" htmlFor={`${prefix}-type`}>
              Match type
            </label>
            <select
              id={`${prefix}-type`}
              className="editor-select mt-2"
              value={draft.ruleType}
              onChange={(event) => update({ ruleType: event.target.value as RoutingRuleType })}
            >
              {ruleTypeOptions.map(([value, copy]) => (
                <option key={value} value={value}>
                  {copy.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="field-label" htmlFor={`${prefix}-priority`}>
              Priority
            </label>
            <input
              id={`${prefix}-priority`}
              className="editor-control mt-2"
              type="number"
              inputMode="numeric"
              min={0}
              max={10_000}
              step={1}
              value={draft.priority}
              aria-describedby={`${prefix}-priority-help ${prefix}-priority-error`}
              aria-invalid={submitted && errors.priority !== undefined ? true : undefined}
              onChange={(event) => update({ priority: event.target.value })}
            />
            <p id={`${prefix}-priority-help`} className="routing-rule-field-help">
              Higher numbers run first. The default is 100.
            </p>
            <p id={`${prefix}-priority-error`} className="routing-rule-field-error" role="alert">
              {submitted ? errors.priority : null}
            </p>
          </div>

          <div>
            <label className="field-label" htmlFor={`${prefix}-destination-kind`}>
              Destination type
            </label>
            <select
              id={`${prefix}-destination-kind`}
              className="editor-select mt-2"
              value={draft.destinationKind}
              onChange={(event) =>
                update({
                  destinationId: "",
                  destinationKind: event.target.value as "note" | "space"
                })
              }
            >
              <option value="note">Note</option>
              <option value="space">Space</option>
            </select>
          </div>

          <div>
            <label className="field-label" htmlFor={`${prefix}-destination`}>
              Active destination
            </label>
            <select
              id={`${prefix}-destination`}
              className="editor-select mt-2"
              value={draft.destinationId}
              disabled={loadingOptions && options.length === 0}
              aria-describedby={`${prefix}-destination-help ${prefix}-destination-error`}
              aria-invalid={submitted && errors.destinationId !== undefined ? true : undefined}
              onChange={(event) => update({ destinationId: event.target.value })}
            >
              <option value="">
                {loadingOptions
                  ? "Loading destinations…"
                  : options.length === 0
                    ? `No active ${draft.destinationKind}s`
                    : `Choose a ${draft.destinationKind}`}
              </option>
              {currentDestinationMissing ? (
                <option value={currentDestinationId ?? ""}>Current {draft.destinationKind}</option>
              ) : null}
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {"title" in option ? option.title : option.name}
                </option>
              ))}
            </select>
            <p id={`${prefix}-destination-help`} className="routing-rule-field-help">
              Only active destinations can receive new jots.
            </p>
            <p id={`${prefix}-destination-error`} className="routing-rule-field-error" role="alert">
              {submitted ? errors.destinationId : null}
            </p>
            {hasMore ? (
              <div className="routing-rule-picker-footer">
                <button
                  type="button"
                  className="quiet-button"
                  disabled={loadingMore}
                  onClick={draft.destinationKind === "note" ? onLoadMoreNotes : onLoadMoreSpaces}
                >
                  {loadingMore ? "Loading more…" : `Load more ${draft.destinationKind}s`}
                </button>
              </div>
            ) : null}
          </div>

          <label className="routing-rule-enabled-field">
            <span>
              <strong>{rule === null ? "Start active" : "Rule active"}</strong>
              <small>Pause it when you want to keep the instruction without using it.</small>
            </span>
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => update({ enabled: event.target.checked })}
            />
          </label>
        </div>

        {destinationError === null ? null : (
          <p className="routing-rule-form-notice" role="status">
            {destinationError} You can close this editor and try again.
          </p>
        )}

        <div className="routing-rule-form-actions">
          <button type="button" className="button-secondary" disabled={pending} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="button-primary" disabled={pending || !canSave}>
            <UnfiledGlyph glyph="check" size={17} weight={2.2} />
            {pending ? "Saving…" : rule === null ? "Create rule" : "Save changes"}
          </button>
        </div>
      </form>
    </section>
  );
}

export function RoutingRuleItem({
  confirmingRemoval,
  destination,
  onAccept,
  onCancelRemoval,
  onEdit,
  onRemove,
  onRequestRemoval,
  onToggle,
  pending,
  rule
}: Readonly<{
  confirmingRemoval: boolean;
  destination: string;
  onAccept: () => void;
  onCancelRemoval: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onRequestRemoval: () => void;
  onToggle: () => void;
  pending: boolean;
  rule: RoutingRuleDto;
}>) {
  const offered = rule.proposalState === "offered";
  const blocked = rule.destinationStatus !== "active";
  const state = routingRuleStateLabel(rule);
  const canToggle = rule.enabled || !blocked;

  return (
    <article className="routing-rule-row" data-state={state.toLowerCase()}>
      <div className="routing-rule-copy">
        <div className="routing-rule-title-line">
          <h3>{rule.condition}</h3>
          <span className="routing-rule-state">{state}</span>
        </div>
        <p className="routing-rule-destination">
          <UnfiledGlyph
            glyph={rule.destination.type === "note" ? "library" : "tray"}
            size={16}
            weight={1.9}
          />{" "}
          {destination}
        </p>
        <div className="routing-rule-meta" aria-label="Rule details">
          <span>{ROUTING_RULE_TYPE_COPY[rule.ruleType].label}</span>
          <span>Priority {rule.priority}</span>
          <span>{routingRuleSourceLabel(rule)}</span>
          <span suppressHydrationWarning>{routingRuleLastFiredLabel(rule)}</span>
        </div>
        {blocked ? (
          <p className="routing-rule-warning-copy">
            {offered
              ? "Its destination is no longer active. Decline this suggestion and create a replacement rule."
              : "This rule cannot turn on until you choose an active destination."}
          </p>
        ) : offered ? (
          <p className="routing-rule-suggestion-copy">
            Suggested after repeated corrections. It stays off until you accept it.
          </p>
        ) : null}
      </div>

      <div className="routing-rule-actions">
        {confirmingRemoval ? (
          <div className="routing-rule-confirm" role="group" aria-label="Confirm rule removal">
            <span>{offered ? "Decline this suggestion?" : "Delete this rule?"}</span>
            <button
              type="button"
              className="button-secondary"
              disabled={pending}
              onClick={onCancelRemoval}
            >
              Cancel
            </button>
            <button
              type="button"
              className="routing-rule-danger-button"
              disabled={pending}
              onClick={onRemove}
            >
              <UnfiledGlyph glyph="trash" size={16} weight={1.9} />
              {pending ? "Working…" : offered ? "Decline" : "Delete rule"}
            </button>
          </div>
        ) : offered ? (
          <>
            <button
              type="button"
              className="button-primary"
              disabled={pending || blocked}
              onClick={onAccept}
            >
              <UnfiledGlyph glyph="check" size={17} weight={2.2} /> Accept and turn on
            </button>
            <button
              type="button"
              className="button-secondary"
              disabled={pending}
              onClick={onRequestRemoval}
            >
              Decline
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="routing-rule-toggle"
              data-enabled={rule.enabled}
              aria-pressed={rule.enabled}
              disabled={pending || !canToggle}
              onClick={onToggle}
            >
              {rule.enabled ? "On" : "Off"}
            </button>
            <button type="button" className="button-secondary" disabled={pending} onClick={onEdit}>
              <UnfiledGlyph glyph="pen" size={16} weight={1.9} /> Edit
            </button>
            <button
              type="button"
              className="routing-rule-delete-button"
              disabled={pending}
              onClick={onRequestRemoval}
            >
              <UnfiledGlyph glyph="trash" size={16} weight={1.9} /> Delete
            </button>
          </>
        )}
      </div>
    </article>
  );
}

export function RoutingRulePreview({
  notes,
  rules,
  spaces
}: Readonly<{
  notes: readonly NoteSummary[];
  rules: readonly RoutingRuleDto[];
  spaces: readonly Space[];
}>) {
  const [sample, setSample] = useState("");
  const [hasPreviewed, setHasPreviewed] = useState(false);
  const matchedRule = useMemo(
    () => (hasPreviewed ? previewRoutingRuleMatch(sample, rules) : null),
    [hasPreviewed, rules, sample]
  );
  const codePointCount = Array.from(sample).length;

  function updateSample(value: string): void {
    setSample(boundedRoutingRulePreviewText(value));
    setHasPreviewed(false);
  }

  function preview(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (sample.trim().length === 0) return;
    setHasPreviewed(true);
  }

  return (
    <section className="routing-rule-preview" aria-labelledby="routing-rule-preview-heading">
      <div className="routing-rule-preview-header">
        <div>
          <p className="section-label">Local condition check</p>
          <h3 id="routing-rule-preview-heading">Preview which rule matches</h3>
        </div>
        <span className="routing-rule-preview-privacy">On this device only</span>
      </div>

      <form onSubmit={preview} noValidate>
        <div className="routing-rule-preview-field">
          <label className="field-label" htmlFor="routing-rule-preview-sample">
            Sample capture
          </label>
          <textarea
            id="routing-rule-preview-sample"
            className="editor-control mt-2"
            rows={3}
            value={sample}
            autoComplete="off"
            spellCheck={false}
            aria-describedby="routing-rule-preview-help routing-rule-preview-count"
            onChange={(event) => updateSample(event.target.value)}
          />
          <div className="routing-rule-preview-help-row">
            <p id="routing-rule-preview-help" className="routing-rule-field-help">
              Rule conditions are checked in memory. This text is never sent, saved, or logged.
            </p>
            <p id="routing-rule-preview-count" className="routing-rule-preview-count">
              {codePointCount}/{ROUTING_RULE_PREVIEW_MAX_CODE_POINTS}
            </p>
          </div>
        </div>

        <div className="routing-rule-preview-actions">
          {sample.length > 0 ? (
            <button type="button" className="button-secondary" onClick={() => updateSample("")}>
              Clear
            </button>
          ) : null}
          <button type="submit" className="button-primary" disabled={sample.trim().length === 0}>
            Check rule match
          </button>
        </div>
      </form>

      <div className="routing-rule-preview-result" role="status" aria-live="polite">
        <RoutingRulePreviewResult
          hasPreviewed={hasPreviewed}
          matchedRule={matchedRule}
          notes={notes}
          spaces={spaces}
        />
      </div>
    </section>
  );
}

export function RoutingRulePreviewResult({
  hasPreviewed,
  matchedRule,
  notes,
  spaces
}: Readonly<{
  hasPreviewed: boolean;
  matchedRule: RoutingRuleDto | null;
  notes: readonly NoteSummary[];
  spaces: readonly Space[];
}>) {
  if (!hasPreviewed) {
    return (
      <>
        <strong>Ready for a sample</strong>
        <p>Enter a jot above to compare it with current active rule conditions.</p>
      </>
    );
  }

  if (matchedRule === null) {
    return (
      <>
        <strong>No rule condition matched</strong>
        <p>
          No current active rule condition matched this sample. This local check does not predict
          how the jot will be organized.
        </p>
      </>
    );
  }

  return (
    <>
      <div className="routing-rule-preview-match-line">
        <strong>Rule condition matched locally</strong>
        <span>{routingRuleSourceLabel(matchedRule)}</span>
      </div>
      <p>
        <strong>{matchedRule.condition}</strong> matched this sample.
      </p>
      <p>
        Configured destination: {matchedRule.destination.type === "note" ? "note" : "space"}{" "}
        <strong>{destinationLabel(matchedRule, notes, spaces)}</strong>.
      </p>
      <p>This local check does not confirm actual routing or destination eligibility.</p>
    </>
  );
}

export function RoutingRulesSettings() {
  const resource = useLiveResource<RoutingRuleSnapshot>("/api/v1/routing-rules", loadRoutingRules);
  const notes = usePagedResource<NoteSummary>("/api/v1/notes?limit=100", entityKey);
  const spaces = usePagedResource<Space>("/api/v1/spaces?limit=100", entityKey);
  const [editor, setEditor] = useState<EditorSelection>(null);
  const [filter, setFilter] = useState<RoutingRuleFilter>("all");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [confirmingRemoval, setConfirmingRemoval] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const attempts = useRef(new Map<string, RoutingRuleMutationAttempt>());

  const sortedRules = useMemo(
    () => sortRoutingRules(resource.data?.items ?? []),
    [resource.data?.items]
  );
  const visibleRules = useMemo(
    () => sortedRules.filter((rule) => matchesFilter(rule, filter)),
    [filter, sortedRules]
  );
  const destinationError =
    notes.error ?? spaces.error ?? notes.pageError ?? spaces.pageError ?? null;

  function attemptKey(operation: string, normalizedRequestPayload: unknown): string {
    return routingRuleIdempotencyKeyForAttempt(
      attempts.current,
      operation,
      normalizedRequestPayload,
      createIdempotencyKey
    );
  }

  function upsertRule(rule: RoutingRuleDto): void {
    const current = resource.data?.items ?? [];
    resource.setData({
      items: upsertRoutingRuleWithoutRevisionRegression(current, rule)
    });
    announceProductChange(`routing-rule:${rule.id}`);
  }

  async function runMutation<T>(
    operation: string,
    normalizedRequestPayload: unknown,
    call: (idempotencyKey: string) => Promise<T>,
    apply: (result: T) => void,
    fallback: string
  ): Promise<boolean> {
    if (pendingAction !== null) return false;
    setPendingAction(operation);
    setMutationError(null);
    let reconcilingReplay = false;
    try {
      const result = await call(attemptKey(operation, normalizedRequestPayload));
      if (isReplayedMutation(result)) {
        reconcilingReplay = true;
        const authoritative = await loadRoutingRules();
        resource.setData({
          items: reconcileAuthoritativeRoutingRules(resource.data?.items ?? [], authoritative.items)
        });
        announceProductChange("routing-rules:reconciled");
      } else {
        apply(result);
      }
      attempts.current.delete(operation);
      return true;
    } catch (reason) {
      if (!reconcilingReplay && !isAmbiguousProductMutationFailure(reason)) {
        attempts.current.delete(operation);
      }
      if (isStaleRevision(reason)) {
        setMutationError("This rule changed on another device. The latest version is shown.");
        setEditor(null);
        await resource.refresh();
      } else {
        setMutationError(productErrorMessage(reason, fallback));
      }
      return false;
    } finally {
      setPendingAction(null);
    }
  }

  async function saveRule(draft: RoutingRuleDraft): Promise<void> {
    if (editor === null) return;
    if (editor === "new") {
      const fields = routingRuleCreateFields(draft);
      if (fields === null) return;
      const succeeded = await runMutation(
        "create",
        fields,
        (idempotencyKey) => browserApi.createRoutingRule({ ...fields, idempotencyKey }),
        (result) => upsertRule(result.rule),
        "The routing rule could not be created."
      );
      if (succeeded) setEditor(null);
      return;
    }

    const fields = routingRuleUpdateFields(editor, draft);
    if (fields === null) return;
    const normalizedRequestPayload = {
      ...fields,
      expectedRevision: editor.revision
    };
    const succeeded = await runMutation(
      `update:${editor.id}`,
      normalizedRequestPayload,
      (idempotencyKey) =>
        browserApi.updateRoutingRule(editor.id, {
          ...normalizedRequestPayload,
          idempotencyKey
        }),
      (result) => upsertRule(result.rule),
      "The routing rule could not be saved."
    );
    if (succeeded) setEditor(null);
  }

  async function toggleRule(rule: RoutingRuleDto): Promise<void> {
    const normalizedRequestPayload = {
      enabled: !rule.enabled,
      expectedRevision: rule.revision
    };
    await runMutation(
      `toggle:${rule.id}:${String(!rule.enabled)}`,
      normalizedRequestPayload,
      (idempotencyKey) =>
        browserApi.updateRoutingRule(rule.id, routingRuleToggleRequest(rule, idempotencyKey)),
      (result) => upsertRule(result.rule),
      `The routing rule could not be turned ${rule.enabled ? "off" : "on"}.`
    );
  }

  async function acceptRule(rule: RoutingRuleDto): Promise<void> {
    const normalizedRequestPayload = {
      enabled: true,
      expectedRevision: rule.revision
    };
    await runMutation(
      `accept:${rule.id}`,
      normalizedRequestPayload,
      (idempotencyKey) =>
        browserApi.updateRoutingRule(rule.id, routingRuleAcceptRequest(rule, idempotencyKey)),
      (result) => upsertRule(result.rule),
      "The suggested rule could not be accepted."
    );
  }

  async function removeRule(rule: RoutingRuleDto): Promise<void> {
    const normalizedRequestPayload = { expectedRevision: rule.revision };
    const succeeded = await runMutation(
      `${rule.proposalState === "offered" ? "decline" : "delete"}:${rule.id}`,
      normalizedRequestPayload,
      (idempotencyKey) =>
        browserApi.deleteRoutingRule(rule.id, routingRuleRemovalRequest(rule, idempotencyKey)),
      () => {
        resource.setData({
          items: (resource.data?.items ?? []).filter((candidate) => candidate.id !== rule.id)
        });
        announceProductChange(`routing-rule:${rule.id}:removed`);
      },
      rule.proposalState === "offered"
        ? "The suggestion could not be declined."
        : "The routing rule could not be deleted."
    );
    if (succeeded) setConfirmingRemoval(null);
  }

  return (
    <section className="settings-row settings-routing-row" aria-labelledby="routing-rules-heading">
      <div className="routing-rules-header">
        <div>
          <h2 id="routing-rules-heading" className="settings-section-title">
            Routing rules
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-content">
            Teach Unfiled where familiar jots belong. Suggested rules stay off until you accept
            them.
          </p>
        </div>
        <button
          type="button"
          className="button-primary"
          disabled={pendingAction !== null || editor !== null}
          onClick={() => {
            setEditor("new");
            setMutationError(null);
          }}
        >
          <UnfiledGlyph glyph="plus" size={17} weight={2.2} /> New rule
        </button>
      </div>

      {editor === null ? null : (
        <RoutingRuleEditor
          key={editor === "new" ? "new" : editor.id}
          rule={editor === "new" ? null : editor}
          notes={notes.data?.items ?? []}
          spaces={spaces.data?.items ?? []}
          notesHasMore={notes.data?.pageInfo.hasMore ?? false}
          spacesHasMore={spaces.data?.pageInfo.hasMore ?? false}
          notesLoading={notes.loading}
          spacesLoading={spaces.loading}
          notesLoadingMore={notes.loadingMore}
          spacesLoadingMore={spaces.loadingMore}
          destinationError={destinationError}
          pending={pendingAction !== null}
          onCancel={() => setEditor(null)}
          onLoadMoreNotes={() => void notes.loadMore()}
          onLoadMoreSpaces={() => void spaces.loadMore()}
          onSave={saveRule}
        />
      )}

      {mutationError === null ? null : (
        <div className="routing-rules-notice" role="alert">
          <UnfiledGlyph glyph="warning" size={18} weight={1.9} />
          <span>{mutationError}</span>
          <button type="button" className="quiet-button" onClick={() => void resource.refresh()}>
            Refresh
          </button>
        </div>
      )}

      {resource.error !== null && resource.data !== null ? (
        <div className="routing-rules-notice" role="status">
          <UnfiledGlyph glyph="warning" size={18} weight={1.9} />
          <span>{resource.offline ? "You’re offline. Showing saved rules." : resource.error}</span>
          <button type="button" className="quiet-button" onClick={() => void resource.refresh()}>
            Try again
          </button>
        </div>
      ) : null}

      {resource.data === null ? null : (
        <RoutingRulePreview
          rules={sortedRules}
          notes={notes.data?.items ?? []}
          spaces={spaces.data?.items ?? []}
        />
      )}

      {resource.loading && resource.data === null ? (
        <RoutingRulesSkeleton />
      ) : resource.error !== null && resource.data === null ? (
        <ResourceError
          message={resource.error}
          offline={resource.offline}
          retry={() => void resource.refresh()}
        />
      ) : sortedRules.length === 0 ? (
        <EmptyState
          title="No routing rules yet."
          body="Create one for a phrase you use often. You can pause or change it at any time."
        />
      ) : (
        <>
          <div className="routing-rules-tools">
            <p aria-live="polite">
              {visibleRules.length} of {sortedRules.length} shown
            </p>
            <div>
              <label htmlFor="routing-rule-filter" className="field-label">
                View
              </label>
              <select
                id="routing-rule-filter"
                className="editor-select mt-2"
                value={filter}
                onChange={(event) => setFilter(event.target.value as RoutingRuleFilter)}
              >
                <option value="all">All rules</option>
                <option value="suggested">Suggested</option>
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                <option value="blocked">Blocked</option>
              </select>
            </div>
          </div>
          {visibleRules.length === 0 ? (
            <div className="routing-rules-filter-empty">
              <p>No rules match this view.</p>
              <button type="button" className="quiet-button" onClick={() => setFilter("all")}>
                Show all rules
              </button>
            </div>
          ) : (
            <div className="routing-rule-list">
              {visibleRules.map((rule) => (
                <RoutingRuleItem
                  key={rule.id}
                  rule={rule}
                  destination={destinationLabel(
                    rule,
                    notes.data?.items ?? [],
                    spaces.data?.items ?? []
                  )}
                  pending={pendingAction !== null}
                  confirmingRemoval={confirmingRemoval === rule.id}
                  onAccept={() => void acceptRule(rule)}
                  onCancelRemoval={() => setConfirmingRemoval(null)}
                  onEdit={() => {
                    setEditor(rule);
                    setMutationError(null);
                  }}
                  onRemove={() => void removeRule(rule)}
                  onRequestRemoval={() => setConfirmingRemoval(rule.id)}
                  onToggle={() => void toggleRule(rule)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
