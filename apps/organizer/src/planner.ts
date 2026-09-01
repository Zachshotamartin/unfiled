import { OrganizerUnavailableError } from "./errors.js";

const JOB_ID_PATTERN = /^job_([0-9A-HJKMNP-TV-Z]{26})$/u;

export type OrganizerCaptureControls = Readonly<{
  expansionDisabled: boolean;
  explicitDestinationNoteId: `note_${string}` | null;
}>;
export type DecryptedCapture = Readonly<{
  controls: OrganizerCaptureControls;
  rawContent: string;
}>;
export type DecryptedCandidate = Readonly<{
  bodyMarkdown: string;
  candidateId: `note_${string}`;
  isOpen: boolean;
  noteId: `note_${string}`;
  noteType: "generic" | "list" | "log" | "principle" | "project";
  revision: number;
  title: string;
}>;
export type PlannerInput = Readonly<{
  capture: DecryptedCapture;
  candidates: readonly DecryptedCandidate[];
  captureId: `cap_${string}`;
  controls: OrganizerCaptureControls;
  signal: AbortSignal;
}>;
export type OrganizerPlanner = Readonly<{ plan(input: PlannerInput): Promise<unknown> }>;

/** The database validates and binds this replay-stable create proposal. */
export function proposedNoteIdForJob(jobId: string): `note_${string}` {
  const suffix = JOB_ID_PATTERN.exec(jobId)?.[1];
  if (suffix === undefined) throw new OrganizerUnavailableError();
  return `note_${suffix}`;
}

export const unavailableProductionPlanner: OrganizerPlanner = Object.freeze({
  plan() {
    return Promise.reject(new OrganizerUnavailableError());
  }
});
