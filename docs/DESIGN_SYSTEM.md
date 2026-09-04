# Design System

Status: **working v1 skeleton.** The visual tokens now follow the selected [Unfiled brand direction](./BRAND_SYSTEM_UNFILED.md); Milestone 0 completes this document with measured contrast evidence, component specs from the high-fidelity screens, and prototype learnings. Sections marked `M0` are filled then.

Design dials: `DESIGN_VARIANCE: 5`, `MOTION_INTENSITY: 3`, `VISUAL_DENSITY: 5`. Read: calm personal utility on a light paper ground ([ADR-0019](./decisions/ADR-0019-paper-design-direction.md)), mobile-first; editor hierarchy, not dashboard density. No black grounds, no stock symbols, no AI-purple gradients, glowing avatars, chat-bubble primary UI, or decorative graphs.

## 1. Color tokens (semantic, Paper)

Semantic names only in components; raw hex lives in `apps/web/src/app/paper.css` and `apps/ios/Unfiled/DesignSystem/UnfiledTheme.swift`, which are the same set. There is no black ground anywhere: the screens sit on a cool light paper, and one deep green is the only accent.

| Token                     | Value     | Role                                                  |
| ------------------------- | --------- | ----------------------------------------------------- |
| `color.canvas`            | `#f3f4f6` | screen ground                                         |
| `color.surface`           | `#ffffff` | fields, cards, the dock                               |
| `color.surface.raised`    | `#e6e8ec` | pressed and secondary controls                        |
| `color.border`            | `#dde1e6` | hairlines                                             |
| `color.text.primary`      | `#14171b` | primary text (ink)                                    |
| `color.text.secondary`    | `#626b76` | metadata, descriptions, section labels                |
| `color.text.disabled`     | `#9aa1ab` | disabled controls and placeholders                    |
| `color.accent`            | `#1e6b57` | the one accent: state dots, links, the primary action |
| `color.accent.pressed`    | `#17543f` | the accent under press                                |
| `color.accent.contrast`   | `#f3f4f6` | text and glyphs on the accent                         |
| `color.danger`            | `#a03a28` | destructive, failed states                            |
| `color.warning`           | `#8a5a12` | pending, attention                                    |
| `color.generated.surface` | `#eaf1ee` | the tinted surface a labelled generated block sits on |

Contrast is asserted in `apps/web/src/components/product/paper-design.test.ts`. The mark follows the ground: an ink tray with a green card, drawn once in `apps/ios/Shared/BrandMark.swift` and `apps/web/src/components/brand-mark.tsx` from the same geometry; the served favicon and `public/brand/unfiled-mark.svg` are the same drawing on the paper ground.

## 2. Typography

- UI face: Geist Sans (fallback: system). Mono: Geist Mono — only timestamps, extracted measurements, technical metadata.
- Scale (mobile base 16): `display 28/34 semibold`, `title 22/28 semibold`, `heading 17/24 semibold`, `body 16/24 regular`, `secondary 14/20 regular`, `caption 12/16 medium`. Web may raise body to 17 in the editor. Numerals: tabular in logs and receipts.
- Dynamic Type / font scaling supported to 200% without truncating capture, receipt, or checklist rows (layout tests at M0).

## 3. Spacing, shape, elevation

- 4-pt spacing grid; component paddings from `{4,8,12,16,20,24,32}`.
- Radius: containers 12, inputs 10, buttons 10; circular only for clear icon actions with ≥44-pt targets.
- Elevation: dark theme uses surface steps + hairline borders, not heavy shadows; max two elevation steps above canvas.

## 4. Motion

Purposeful only; every animation maps to a state change: composer submit compresses into pending row (~250 ms, standard ease-out); receipt slides in when processing completes; undo visibly restores content (highlight fade); note move uses short layout transition (~200 ms). Durations 150–300 ms; nothing loops after load completes; `prefers-reduced-motion` and platform equivalents replace movement with opacity changes.

## 5. Iconography

Phosphor icons, one global weight (regular), 24-pt default, 20-pt in dense rows. No emoji as navigation icons. Every icon-only control has a label for assistive tech and a tooltip on web.

## 6. Component inventory (anatomy + states at M0)

Each component ships with all applicable states: default, hover (web), focus-visible, pressed, disabled, loading, error, offline.

- **Capture composer** (mobile sheet / web inline): text field, save, optional destination/private/expansion controls, character counter past 90%.
- **Pending capture row**: text, state (`queued/processing`), spinner alternative for reduced motion.
- **Receipt card**: action line, inserted content list, generated-block badge, `Open / Move / Undo`.
- **Checklist item**: 44-pt checkbox, text, checked style (strikethrough + secondary color — never color alone), drag handle (web M0 decision), completed-group header with count.
- **Log entry**: date header, exercise rows, tappable numeric field (opens keypad + steppers, prior value placeholder), unparsed-text fallback row.
- **Note card / list row**: title, type glyph, space path, updated time, pinned marker.
- **Note editor**: title field, Markdown body, toolbar (mobile: above keyboard; web: floating), revision indicator, conflict banner.
- **Review item card**: capture text, up to 3 destination chips + `New note`, resolve/dismiss.
- **Generated block**: tinted background, `AI` badge, accept/reject when proposed, provenance link. E3 renders the separately encrypted proposal outside editable user-authored note content; acceptance preserves its generated provenance and rejection hides it without changing the note revision.
- **Rule row** (settings): condition, destination, source badge, last-fired, enable toggle.
- **BYOK key panel** (settings): Provider (OpenAI or Claude) → Model (Automatic or one exact `organization-model-registry-v2` model) → Effort (Efficient/Balanced/Thorough) hierarchy; one masked paste field, validate state, last-four display, status pill, and delete per provider key. Show only the registry-v2 catalog; switching provider resets an incompatible model to Automatic without deleting either key; higher-cost exact models are identified before save; managed fallback is hidden unless the deployment declares it (ADR-0015).
- **Banners**: offline, provider outage, invalid key, budget exhausted.
- Primitives: buttons (primary/secondary/ghost/destructive), inputs, chips, tabs, sheet/dialog, toast, skeletons (must match real layout), empty states.

## 7. Screen inventory and responsive rules

Mobile (design smallest supported viewport first, keyboard open): Today, Capture sheet, Notes (library), Note (per type surface), Review, Search, Settings (+ rules, + BYOK), Archive, onboarding trio. Web: the Desk (Inbox, capture, Library) with a left rail, a content column that fills the width beside it, and on a note's page an optional inspector; the inspector is never required for editing. The content column has no maximum width: measures belong to the prose inside it, and the side gutter (`--space-desk-gutter`) grows with the viewport. Every part of a note's page (toolbar, meta, title and body, checklist, log, generated blocks) shares one left edge, `--space-editor-gutter`. Breakpoints as implemented: 640 (desk gutters and editor meta grid), 768 (the rail appears and the dock stands down), 1024 (the auth split), 1280 (the rail gains labels; the note inspector docks beside the note).

## 8. Accessibility requirements (tested, per OPERATIONS_TEST_PLAN §7)

- WCAG 2.1 AA minimum; AAA contrast for primary reading text.
- Touch targets ≥ 44×44 pt; web keyboard: every action reachable, visible focus ring (2 px accent), logical order, escape closes sheets.
- Screen reader: labels on all controls; live announcements for `Saved`, processing completion, receipt arrival, errors, undo results; checklist announces `checked, N of M remaining`; generated blocks announce as AI-generated.
- State never conveyed by color alone (icons/text accompany); reduced-motion and reduced-transparency honored; loading skeletons match final layout to prevent shift.

## 9. Content style

Functional labels (`Write something`, `Added to Shopping`, `Needs your input`); receipts in plain past-tense sentences; errors say what happened and the next step, never codes alone (codes in details); AI provenance always visible (`AI-generated`, never `magic`); avoid anthropomorphizing the product or AI.

## 10. M0 deliverables checklist (design sprint exit)

- [ ] Final token sheet with measured contrast pairs
- [ ] Journey map + IA diagram
- [ ] Lo-fi mobile + desktop wireframes (all screens §7)
- [ ] Hi-fi flagship mobile flow incl. toggle + numeric edit
- [ ] Hi-fi web Today/Notes/editor/Search/Review
- [ ] All component states specced (§6)
- [ ] Clickable prototype (shopping / workout / mindset / ambiguous / manual edit / undo)
- [ ] Usability notes + resolved decisions recorded here
- [ ] Accessibility annotations complete
