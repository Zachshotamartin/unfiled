import type { AuthSession } from "./auth.js";
import type {
  CaptureCreateRequest,
  CaptureCreateResponse,
  CaptureDetailResponse,
  CaptureListResponse,
  CaptureReceipt
} from "./captures.js";
import type { MutationResult } from "./mutations.js";
import type { NoteDto, NoteSummary } from "./notes.js";
import type { UserOperation } from "./operations.js";
import type { NoteRevisionDto } from "./revisions.js";
import type { SearchNoteResult } from "./search.js";
import type { Space } from "./spaces.js";
import type { Tag } from "./tags.js";

export const captureV1Fixture = Object.freeze({
  clientCaptureId: "cap_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  rawContent: "shopping: milk and batteries",
  source: "ios_lock_screen_widget",
  clientCreatedAt: "2026-08-30T18:30:00.000Z",
  clientTimezone: "America/Los_Angeles",
  privacy: "ai_assisted",
  expansionDisabled: false
}) satisfies CaptureCreateRequest;

export const captureV1ResponseFixture = Object.freeze({
  capture: Object.freeze({
    id: captureV1Fixture.clientCaptureId,
    rawContent: captureV1Fixture.rawContent,
    source: captureV1Fixture.source,
    deviceId: "iphone-15-pro",
    privacy: captureV1Fixture.privacy,
    explicitDestinationNoteId: null,
    expansionDisabled: captureV1Fixture.expansionDisabled,
    clientCreatedAt: captureV1Fixture.clientCreatedAt,
    clientTimezone: captureV1Fixture.clientTimezone,
    receivedAt: "2026-08-30T18:30:01.000Z",
    status: "queued",
    lastErrorCode: null
  }),
  jobId: "job_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
  replayed: false
}) satisfies CaptureCreateResponse;

export const captureV1ReceiptFixture = Object.freeze({
  schemaVersion: 1,
  captureId: captureV1Fixture.clientCaptureId,
  jobId: captureV1ResponseFixture.jobId,
  decisionId: "dec_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  reviewItemId: null,
  mutationId: "mut_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  outcome: "added_to_note",
  headline: "Added 2 items to Shopping / Aug 30",
  destination: Object.freeze({
    noteId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X",
    title: "Shopping"
  }),
  insertedContent: [
    Object.freeze({
      type: "captured",
      itemId: "itm_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      content: "milk"
    }),
    Object.freeze({
      type: "captured",
      itemId: "itm_01J6M9Q7G4BMKB33GSG3NJ6D1Y",
      content: "batteries"
    })
  ],
  actions: [
    Object.freeze({
      type: "open",
      noteId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X"
    }),
    Object.freeze({
      type: "move",
      noteId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      decisionId: "dec_01J6M9Q7G4BMKB33GSG3NJ6D1X"
    }),
    Object.freeze({
      type: "undo",
      mutationId: "mut_01J6M9Q7G4BMKB33GSG3NJ6D1X",
      expectedRevision: 2
    })
  ],
  reasonCodes: ["high_confidence"],
  createdAt: "2026-08-30T18:30:03.000Z"
}) satisfies CaptureReceipt;

export const captureV1DetailFixture = Object.freeze({
  capture: Object.freeze({
    ...captureV1ResponseFixture.capture,
    status: "done",
    jobId: captureV1ResponseFixture.jobId,
    receipt: captureV1ReceiptFixture,
    attachments: []
  })
}) satisfies CaptureDetailResponse;

export const captureV1ListFixture = Object.freeze({
  items: [
    Object.freeze({
      id: captureV1Fixture.clientCaptureId,
      jobId: captureV1ResponseFixture.jobId,
      rawContentPreview: captureV1Fixture.rawContent,
      source: captureV1Fixture.source,
      privacy: captureV1Fixture.privacy,
      clientCreatedAt: captureV1Fixture.clientCreatedAt,
      receivedAt: captureV1ResponseFixture.capture.receivedAt,
      status: "done",
      lastErrorCode: null,
      receiptAvailable: true
    })
  ],
  pageInfo: Object.freeze({ hasMore: false, nextCursor: null })
}) satisfies CaptureListResponse;

const note = {
  id: "note_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  spaceId: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  type: "list",
  title: "Shopping",
  bodyMarkdown: "- [ ] milk",
  structuredData: {
    schemaVersion: 1,
    items: [
      {
        id: "itm_01J6M9Q7G4BMKB33GSG3NJ6D1X",
        text: "milk",
        checked: false,
        ordinal: 0,
        section: null
      }
    ]
  },
  currentRevision: 1,
  isOpen: true,
  pinnedAt: null,
  privacy: "ai_assisted",
  archivedAt: null,
  deletedAt: null,
  tagIds: ["tag_01J6M9Q7G4BMKB33GSG3NJ6D1X"],
  links: [],
  createdAt: "2026-08-30T18:30:00.000Z",
  updatedAt: "2026-08-30T18:30:00.000Z"
} satisfies NoteDto;

const summary = {
  id: note.id,
  spaceId: note.spaceId,
  type: note.type,
  title: note.title,
  currentRevision: note.currentRevision,
  isOpen: note.isOpen,
  pinnedAt: note.pinnedAt,
  privacy: note.privacy,
  archivedAt: note.archivedAt,
  deletedAt: note.deletedAt,
  updatedAt: note.updatedAt
} satisfies NoteSummary;

const revision = {
  id: "rev_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  noteId: note.id,
  revision: 1,
  source: "manual",
  spaceId: note.spaceId,
  type: note.type,
  title: note.title,
  bodyMarkdown: note.bodyMarkdown,
  structuredData: note.structuredData,
  isOpen: note.isOpen,
  pinnedAt: note.pinnedAt,
  privacy: note.privacy,
  archivedAt: note.archivedAt,
  deletedAt: note.deletedAt,
  tagIds: note.tagIds,
  links: note.links,
  contentHash: "a".repeat(64),
  actor: "user:create",
  createdAt: note.createdAt
} satisfies NoteRevisionDto;

const space = {
  id: "spc_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  parentId: null,
  name: "Shopping",
  slug: "shopping",
  sortKey: "a0",
  currentRevision: 1,
  archivedAt: null,
  createdAt: "2026-08-30T18:30:00.000Z",
  updatedAt: "2026-08-30T18:30:00.000Z"
} satisfies Space;

const tag = {
  id: "tag_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  name: "shopping",
  currentRevision: 1,
  createdAt: "2026-08-30T18:30:00.000Z"
} satisfies Tag;

const searchResult = {
  noteId: note.id,
  title: note.title,
  type: note.type,
  snippet: "milk",
  spacePath: ["Shopping"],
  updatedAt: note.updatedAt,
  archivedAt: null
} satisfies SearchNoteResult;

const authSession = {
  accessToken: "fixture-access-token",
  refreshToken: "fixture-refresh-token",
  expiresAt: "2026-08-30T19:30:00.000Z",
  user: {
    id: "00000000-0000-4000-8000-000000000001",
    email: "person@example.com"
  }
} satisfies AuthSession;

const userOperations = [
  { type: "set_title", title: "Groceries" },
  { type: "replace_body_markdown", bodyMarkdown: "- [ ] milk" },
  { type: "set_privacy", privacy: "private_manual" },
  { type: "move_to_space", spaceId: space.id },
  { type: "set_archived", archivedAt: "2026-08-30T18:31:00.000Z" },
  { type: "set_deleted", deletedAt: "2026-08-30T18:31:00.000Z" },
  { type: "set_tags", tagIds: [tag.id] },
  {
    type: "set_note_links",
    links: [{ toNoteId: "note_01J6M9Q7G4BMKB33GSG3NJ6D1Y", linkType: "related" }]
  },
  {
    type: "toggle_item_checked",
    itemId: "itm_01J6M9Q7G4BMKB33GSG3NJ6D1X",
    checked: true
  },
  {
    type: "update_log_field",
    entryId: "ent_01J6M9Q7G4BMKB33GSG3NJ6D1X",
    fieldPath: ["weight"],
    value: 225
  },
  { type: "edit_item_text", itemId: "itm_01J6M9Q7G4BMKB33GSG3NJ6D1X", text: "oat milk" },
  { type: "remove_item", itemId: "itm_01J6M9Q7G4BMKB33GSG3NJ6D1X" },
  {
    type: "restore_snapshot",
    spaceId: note.spaceId,
    noteType: note.type,
    title: note.title,
    bodyMarkdown: note.bodyMarkdown,
    structuredData: note.structuredData,
    privacy: note.privacy,
    isOpen: note.isOpen,
    pinnedAt: note.pinnedAt,
    archivedAt: note.archivedAt,
    deletedAt: note.deletedAt,
    tagIds: note.tagIds,
    links: note.links
  }
] satisfies UserOperation[];

const mutationResult = {
  note,
  revision,
  mutationId: "mut_01J6M9Q7G4BMKB33GSG3NJ6D1X",
  replayed: false,
  undo: { eligible: true, expiresAt: "2026-09-29T18:30:00.000Z" }
} satisfies MutationResult;

export const manualNoteFixtures = Object.freeze({
  authSession,
  mutationResult,
  note,
  revision,
  searchResult,
  space,
  summary,
  tag,
  userOperations
});
