# Design System

Status: **working v1 skeleton.** The visual tokens now follow the selected [Unfiled brand direction](./BRAND_SYSTEM_UNFILED.md); Milestone 0 completes this document with measured contrast evidence, component specs from the high-fidelity screens, and prototype learnings. Sections marked `M0` are filled then.

Design dials: `DESIGN_VARIANCE: 5`, `MOTION_INTENSITY: 3`, `VISUAL_DENSITY: 5`. Read: calm personal utility, dark-first, mobile-first; editor hierarchy, not dashboard density. No AI-purple gradients, glowing avatars, chat-bubble primary UI, or decorative graphs.

## 1. Color tokens (semantic, dark-first)

Semantic names only in components; raw hex lives here. All pairs require recorded contrast ratios at M0; targets: AA minimum everywhere, AAA (≥7:1) for primary reading text.

| Token                   | Draft value                              | Role                                   | Contrast vs canvas (approx, verify M0) |
| ----------------------- | ---------------------------------------- | -------------------------------------- | -------------------------------------- |
| `color.canvas`          | `#0B0C0E` (Ink)                          | app background                         | —                                      |
| `color.surface`         | `#181B1F` (Graphite)                     | panes, composer                        | —                                      |
| `color.surface.raised`  | `#22262A`                                | sheets, menus                          | —                                      |
| `color.border`          | `rgba(242, 239, 232, 0.14)`              | hairlines, dividers                    | non-text                               |
| `color.text.primary`    | `#F2EFE8` (Warm Paper)                   | body text                              | verify M0; target AAA                  |
| `color.text.secondary`  | `#9DA3A6` (Fog)                          | metadata, timestamps                   | verify M0; target AA                   |
| `color.accent`          | `#EE6F55` (Persimmon)                    | capture actions, selection, provenance | verify M0; target AA                   |
| `color.accent.contrast` | `#0B0C0E`                                | text on accent fills                   | verify ≥4.5:1                          |
| `color.danger`          | M0: muted coral, chosen by contrast test | destructive, failed states             | ≥4.5:1 required                        |
| `color.warning`         | M0                                       | pending/attention                      | ≥4.5:1                                 |
| `color.state.generated` | M0: accent-tinted surface                | generated-block background + badge     | non-color indicator also required      |

One accent across the product. No pure black/white. A future light theme re-maps tokens only; components never reference hex. Theme delivery: CSS variables (web), token object via NativeWind/StyleSheet (native), single source in `packages/design-tokens`.

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
- **BYOK key panel** (settings): E4-only provider select, paste field (masked), validate state, last-four display, status pill, delete. Show only server-discovered provider/tiers whose adapter/eval gate passed; Anthropic is currently hidden.
- **Banners**: offline, provider outage, invalid key, budget exhausted.
- Primitives: buttons (primary/secondary/ghost/destructive), inputs, chips, tabs, sheet/dialog, toast, skeletons (must match real layout), empty states.

## 7. Screen inventory and responsive rules

Mobile (design smallest supported viewport first, keyboard open): Today, Capture sheet, Notes (library), Note (per type surface), Review, Search, Settings (+ rules, + BYOK), Archive, onboarding trio. Web: same set with left rail + center pane + optional inspector (backlinks, routing history, source captures); rail collapses ≤1024 px; inspector never required for editing. Breakpoints: 640 / 1024 / 1440.

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
