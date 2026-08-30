import type { CaptureKind, NoteType, OrganizationPlan } from "@unfiled/contracts";

export type CandidateAgeBucket = "today" | "week" | "month" | "older";

export type OrganizationCandidate = Readonly<{
  candidateId: `note_${string}`;
  title: string;
  type: NoteType;
  spacePath: string;
  isOpen: boolean;
  ageBucket: CandidateAgeBucket;
  headings: readonly string[];
  latestSnippet: string;
}>;

export type OrganizationModelInput = Readonly<{
  captureId: `cap_${string}`;
  text: string;
  inferredKind: CaptureKind;
  candidates: readonly OrganizationCandidate[];
}>;

export interface OrganizationModel {
  plan(input: OrganizationModelInput): Promise<OrganizationPlan>;
}
