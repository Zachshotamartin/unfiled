import type { NoteType, PrivacyMode } from "../../packages/contracts/src/enums.js";

export const DEMO_MANIFEST_VERSION = "g-demo-2026-09-02-v1";

export type DemoProfile = "fresh" | "portfolio";

export type DemoSpaceKey = "life" | "projects";
export type DemoTagKey = "fitness" | "mindset" | "project" | "shopping" | "synthetic";
export type DemoNoteKey =
  "account-label" | "garden" | "mindset" | "project" | "shopping" | "weekend-errands" | "workout";

export type DemoSpaceSpec = Readonly<{
  idempotencyKey: string;
  key: DemoSpaceKey;
  name: string;
  sortKey: string;
}>;

export type DemoTagSpec = Readonly<{
  idempotencyKey: string;
  key: DemoTagKey;
  name: string;
}>;

export type DemoNoteSpec = Readonly<{
  bodyMarkdown: string;
  idempotencyKey: string;
  key: DemoNoteKey;
  linkTo?: DemoNoteKey;
  privacy: PrivacyMode;
  space: DemoSpaceKey | null;
  tags: readonly DemoTagKey[];
  title: string;
  type: NoteType;
  updateBodyMarkdown?: string;
  updateIdempotencyKey?: string;
}>;

export const PORTFOLIO_SETTINGS = Object.freeze({
  idempotencyKey: `${DEMO_MANIFEST_VERSION}-settings-locale-timezone`,
  locale: "en-US",
  timezone: "America/Los_Angeles"
});

export const PORTFOLIO_SPACES: readonly DemoSpaceSpec[] = Object.freeze([
  {
    idempotencyKey: `${DEMO_MANIFEST_VERSION}-space-life`,
    key: "life",
    name: "Life",
    sortKey: "demo-01-life"
  },
  {
    idempotencyKey: `${DEMO_MANIFEST_VERSION}-space-projects`,
    key: "projects",
    name: "Projects",
    sortKey: "demo-02-projects"
  }
]);

export const PORTFOLIO_TAGS: readonly DemoTagSpec[] = Object.freeze([
  {
    idempotencyKey: `${DEMO_MANIFEST_VERSION}-tag-synthetic`,
    key: "synthetic",
    name: "synthetic-demo"
  },
  {
    idempotencyKey: `${DEMO_MANIFEST_VERSION}-tag-shopping`,
    key: "shopping",
    name: "shopping"
  },
  {
    idempotencyKey: `${DEMO_MANIFEST_VERSION}-tag-fitness`,
    key: "fitness",
    name: "fitness"
  },
  {
    idempotencyKey: `${DEMO_MANIFEST_VERSION}-tag-mindset`,
    key: "mindset",
    name: "mindset"
  },
  {
    idempotencyKey: `${DEMO_MANIFEST_VERSION}-tag-project`,
    key: "project",
    name: "project"
  }
]);

export const WORKOUT_LOG_BODY = [
  "## 2026-08-24T17:00:00.000-07:00",
  "",
  "- exercise: bench press",
  "- set_1_reps: 8",
  "- set_1_weight_lb: 125",
  "",
  "## 2026-08-31T17:00:00.000-07:00",
  "",
  "- exercise: bench press",
  "- incline_dumbbell_reps: 10",
  "- incline_dumbbell_sets: 3",
  "- incline_dumbbell_weight_lb: 45",
  "- set_1_reps: 8",
  "- set_1_weight_lb: 135",
  "- set_2_reps: 6",
  "- set_2_weight_lb: 145",
  "- set_3_reps: 4",
  "- set_3_weight_lb: 155"
].join("\n");

export const PORTFOLIO_NOTES: readonly DemoNoteSpec[] = Object.freeze([
  {
    bodyMarkdown: [
      "This account contains fictional content created only for the Unfiled portfolio demo.",
      "",
      "Do not add personal notes, credentials, real contacts, or customer support data."
    ].join("\n"),
    idempotencyKey: `${DEMO_MANIFEST_VERSION}-note-account-label`,
    key: "account-label",
    privacy: "private_manual",
    space: null,
    tags: [],
    title: "Synthetic demo data",
    type: "generic"
  },
  {
    bodyMarkdown: ["- [ ] oat milk", "- [ ] spinach", "- [ ] batteries", "- [ ] bananas"].join(
      "\n"
    ),
    idempotencyKey: `${DEMO_MANIFEST_VERSION}-note-shopping`,
    key: "shopping",
    privacy: "ai_assisted",
    space: "life",
    tags: ["synthetic", "shopping"],
    title: "Shopping",
    type: "list"
  },
  {
    bodyMarkdown: "",
    idempotencyKey: `${DEMO_MANIFEST_VERSION}-note-workout`,
    key: "workout",
    privacy: "ai_assisted",
    space: "life",
    tags: ["synthetic", "fitness"],
    title: "Push workout",
    type: "log",
    updateBodyMarkdown: WORKOUT_LOG_BODY,
    updateIdempotencyKey: `${DEMO_MANIFEST_VERSION}-note-workout-structure`
  },
  {
    bodyMarkdown: [
      "## Captured thought",
      "",
      "Tell people you can do it, then figure out what the commitment requires.",
      "",
      "## Generated interpretation (synthetic fixture)",
      "",
      "A public commitment can create useful pressure to learn and follow through.",
      "",
      "_Deterministic stand-in seeded manually; not evidence of a model-generated block or a historical attribution._"
    ].join("\n"),
    idempotencyKey: `${DEMO_MANIFEST_VERSION}-note-mindset`,
    key: "mindset",
    privacy: "ai_assisted",
    space: "life",
    tags: ["synthetic", "mindset"],
    title: "Mindset",
    type: "principle"
  },
  {
    bodyMarkdown: ["- [ ] return library books", "- [ ] replace porch light"].join("\n"),
    idempotencyKey: `${DEMO_MANIFEST_VERSION}-note-weekend-errands`,
    key: "weekend-errands",
    privacy: "private_manual",
    space: "life",
    tags: ["synthetic"],
    title: "Weekend errands",
    type: "list"
  },
  {
    bodyMarkdown: [
      "## Next",
      "",
      "- [ ] Record the fresh-user acceptance take.",
      "- [ ] Verify captions against the final audio.",
      "- [ ] Publish the architecture text alternative."
    ].join("\n"),
    idempotencyKey: `${DEMO_MANIFEST_VERSION}-note-project`,
    key: "project",
    privacy: "private_manual",
    space: "projects",
    tags: ["synthetic", "project"],
    title: "Unfiled demo polish",
    type: "project"
  },
  {
    bodyMarkdown: "Move basil to the brighter window. Check the soil on Thursday.",
    idempotencyKey: `${DEMO_MANIFEST_VERSION}-note-garden`,
    key: "garden",
    linkTo: "weekend-errands",
    privacy: "ai_assisted",
    space: "projects",
    tags: ["synthetic", "project"],
    title: "Garden notes",
    type: "generic"
  }
]);

export const PORTFOLIO_PLANNED_WRITES =
  1 +
  PORTFOLIO_SPACES.length +
  PORTFOLIO_TAGS.length +
  PORTFOLIO_NOTES.length +
  PORTFOLIO_NOTES.filter(({ updateBodyMarkdown }) => updateBodyMarkdown !== undefined).length;
