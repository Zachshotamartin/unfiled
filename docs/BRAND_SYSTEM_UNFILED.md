# Unfiled Brand System

Status: **selected product identity, v1.0.** The product and repository are named `Unfiled`; trademark, App Store, package-name, social-handle, and domain clearance remain release gates.

This document is the visual and verbal source of truth for the public website, authenticated web product, iPhone app, and Lock Screen capture widget. The generated images under `design/brand/` are art-direction references. Where lettering, colors, icons, or tiny UI details in an image disagree with this document, this document wins.

## 1. Brand idea

Unfiled is for the thought that arrives before its category. The product accepts loose input, finds the useful destination, shows what changed, and keeps the original close at hand.

- **Position:** the capture-first notes app that organizes after you write.
- **Promise:** write without making an organizational decision first.
- **Primary tagline:** `Just write. It finds its place.`
- **Product descriptor:** `Notes that organize themselves.`
- **Supporting line:** `One thought in. One useful note out.`
- **Trust line:** `Original preserved. Every change visible. Undo always available.`
- **Closing line:** `Write it down before it disappears.`

The product is not positioned as an AI research environment, a personal knowledge graph, or a chat assistant. AI stays backstage; the visible product is capture, placement, receipts, editing, and control.

## 2. Personality

Unfiled is calm, candid, capable, humane, and slightly unconventional. It should feel like a beautifully made personal object: tactile enough to be memorable, restrained enough to disappear while writing.

The brand is never mystical, overly clever, corporate, productivity-maximalist, or excited about AI for its own sake.

## 3. Logo system

### 3.1 Symbol

The primary symbol is an open geometric lowercase `u` that also reads as an intake tray. One persimmon rectangular slip enters from above. The negative space inside the tray represents a thought finding a place; the open top preserves the idea of unfinished, incoming material.

Production construction:

- redraw the mark as vector geometry before shipping; do not trace pixels from the generated board;
- use a monoline or optically balanced geometric `u` with a flat inner landing shelf;
- set the slip at a consistent slight clockwise angle, approximately 12–16 degrees;
- preserve a visible gap between slip and tray so the mark reads at small sizes;
- use a square artboard and optically center the combined form;
- produce filled, one-color, reversed, and WidgetKit-compatible template variants.

The symbol must remain recognizable at 16 px. Below 24 px, remove secondary construction detail and use the simplified filled mark.

### 3.2 Wordmark

The wordmark is always lowercase: `unfiled`. It uses a sturdy neo-grotesk construction with open counters and modest spacing. The preferred lockup places the mark to the left with a gap equal to roughly half the mark width. Do not capitalize it in the logo, stretch it, outline it, add punctuation, or place it inside a badge.

Use the standalone symbol for the app icon, compact capture control, favicon, and circular Lock Screen widget. Use the horizontal lockup for navigation, onboarding, marketing, and settings.

### 3.3 Clear space and backgrounds

Keep clear space equal to the width of the coral slip on every side. The preferred presentation is warm-paper mark and wordmark on Ink, or Ink mark and wordmark on Warm Paper. The slip remains coral when color is available. In monochrome and WidgetKit rendering modes, the complete mark becomes a single template color.

## 4. Color system

These values are authoritative. Generated reference images may contain imperfect printed hex labels and must not be sampled for implementation.

| Brand token | Hex       | Product token          | Use                                                  |
| ----------- | --------- | ---------------------- | ---------------------------------------------------- |
| Ink         | `#0B0C0E` | `color.canvas`         | primary dark background, ink on light fields         |
| Graphite    | `#181B1F` | `color.surface`        | panes, composer, elevated dark regions               |
| Warm Paper  | `#F2EFE8` | `color.text.primary`   | primary type, light editorial fields                 |
| Persimmon   | `#EE6F55` | `color.accent`         | capture action, active indicator, routing provenance |
| Fog         | `#9DA3A6` | `color.text.secondary` | timestamps, metadata, supporting copy                |

Supporting interface values are derived rather than treated as new brand colors:

- `color.surface.raised`: `#22262A`
- `color.border`: `rgba(242, 239, 232, 0.14)`
- `color.text.disabled`: `rgba(157, 163, 166, 0.55)`
- `color.accent.contrast`: `#0B0C0E`
- focus ring: 2 px Persimmon plus a 1 px Ink separation ring where needed

Persimmon is a navigation and provenance signal, not a decorative fill. Keep it below roughly 10% of a typical product screen. Never create an AI-specific purple or blue palette.

Before implementation freeze, record WCAG contrast measurements for every text/background pair. The targets remain AA everywhere and AAA for primary reading text.

## 5. Typography

- **Product and marketing:** Geist Sans variable, with the system sans stack as fallback.
- **Metadata and technical values:** Geist Mono, reserved for timestamps, paths, counts, and routing labels.
- **Wordmark:** custom optical drawing based on the same neo-grotesk character.

Marketing headlines use wide measures, strong scale, and few line breaks. Product screens use sentence case and a quieter hierarchy. Do not ship the handwritten script seen on paper slips in some visual references; that treatment represents raw human input in art direction, not an interface font.

Core product scale remains: display `28/34 semibold`, title `22/28 semibold`, heading `17/24 semibold`, body `16/24 regular`, secondary `14/20 regular`, caption `12/16 medium`. Marketing display sizes are fluid with `clamp()` and should not wrap into more than three lines on target desktop widths.

## 6. Graphic language

The signature motif is a loose rectangular slip moving into an ordered line, tray, or ledger. Use it to explain the product, connect sections, and mark provenance. A single slip is stronger than a cloud of sticky notes.

- Tactile paper grain may appear in marketing, onboarding, and empty states at low opacity.
- Product surfaces stay crisp; texture must never reduce text contrast or editing clarity.
- Hairlines, registration marks, index numbers, and mono metadata create an editorial archival quality.
- The open `u` can become an architectural crop, tray, or negative-space frame.
- Corners are restrained: 10–16 px for product controls, nearly square in editorial layouts.
- Use flat fields and material contrast; no gradients, glassmorphism, or glowing effects.

Do not use brains, heads, neural nodes, sparkles, magic wands, folder illustrations, rainbow sticky notes, or generic chatbot bubbles. In generated references that contain one of those details, replace it with the Unfiled mark, a path/taxonomy glyph, or plain provenance text.

## 7. iPhone app application

The mobile hierarchy is capture-first, with five primary destinations: Today, Notes, Capture, Review, and Search. Capture can occupy a distinct central action, but it must use the Unfiled intake mark or a plain compose glyph—not a sparkle.

### 7.1 Flagship screens

- **Lock Screen:** a quiet system-native launch surface. Circular uses the simplified mark; rectangular uses the mark plus `Write something`. It never exposes note text or destination names by default.
- **Quick capture:** one focused multiline input, keyboard immediately available, one coral submit action. No title, type, or folder is required before writing.
- **Today:** an editorial ledger of receipts such as `Added to Shopping`, `Updated Push Workout`, and `Added to Mindset`.
- **Notes:** direct manual navigation with search, All/Spaces switching, legible note-type rows, and updated times.
- **Note detail:** the note content is primary; provenance is a quiet linked line such as `Updated from 2 captures`.
- **Review:** show the original capture, proposed destination, confidence context when useful, and explicit `Accept`, `Move`, and `Keep in Inbox` actions.

Generated mobile references live in `design/brand/mobile/`. They demonstrate tone and hierarchy, not pixel-perfect platform specifications.

### 7.2 Lock Screen implementation note

The widget launches an already-focused app composer; WidgetKit does not host a free-form keyboard text field. It must adapt to monochrome, accented, tinted, and clear system appearances. Full native target, deep-link, App Group, offline persistence, performance-budget, and physical-device test details are in [BUILD_PLAN.md](./BUILD_PLAN.md#0-priority-feature-iphone-lock-screen-quick-capture).

## 8. Authenticated web application

The signed-in web product is an editor, not a dashboard. At desktop widths it uses:

1. a narrow left rail for Today, Notes, Spaces, Review, and Search;
2. one dominant center workspace for capture and content;
3. an optional right context pane for routing history, original capture, and undo.

The Today feed is a continuous ledger separated by rules, not a set of floating KPI cards. The capture field remains immediately available. At 1024 px and below, collapse the rail; remove the context pane before compressing the editor. At mobile widths, use the native-app information hierarchy.

Reference: `design/brand/web/07-authenticated-app.png`.

## 9. Marketing website

The homepage is a six-section narrative, with one concept per viewport-sized section:

1. **Promise:** `Just write. It finds its place.`
2. **Problem:** `No titles. No folders. No filing first.`
3. **Mechanism:** `One thought in. One useful note out.`
4. **Breadth:** `Whatever is on your mind.`
5. **Trust:** `Nothing happens behind your back.`
6. **Action:** `Write it down before it disappears.`

Alternate Ink and Warm Paper fields to create rhythm. Use real product crops, tactile slips, and the intake mark rather than stock photography or abstract AI imagery. The primary marketing CTA is `Join the waitlist` until the product is available; then change it globally to the appropriate download or sign-up action.

The six standalone section references live in `design/brand/web/01-hero.png` through `06-final-cta.png`. They are intentionally separate so implementation can preserve readable scale rather than reconstructing a compressed mood board.

## 10. Components and states

- **Capture composer:** Graphite field, Warm Paper input, thin border, coral submit action. Placeholder: `Write something`.
- **Receipt:** plain past-tense outcome first, original capture second, destination and time in mono metadata, `Undo` always discoverable.
- **Routing indicator:** one coral slip or dot plus text. Never color alone.
- **Note row:** title, quiet type label/path, updated time; avoid decorative containers.
- **Primary CTA:** Persimmon fill with Ink label. Reserve it for the highest-priority action in a region.
- **Secondary action:** transparent with hairline border and Warm Paper label.
- **Generated expansion:** visibly labeled and distinguishable from original text; do not use magical language.

All controls require default, hover where applicable, focus-visible, pressed, disabled, loading, error, and offline states. Touch targets are at least 44×44 pt.

## 11. Motion and sound

Motion explains placement. A submitted capture may compress into a slip, travel a short distance, and settle into its receipt in 200–300 ms. Undo reverses that spatial relationship. No particles, celebratory bursts, floating ambient loops, or continuous logo motion. Reduced-motion mode uses opacity and immediate state changes.

Haptics are subtle: light impact on local save and success notification only after durable acknowledgement. Do not play sound by default.

## 12. Voice and interface copy

Write in short, plain, factual sentences. Lead with the outcome and name the destination.

Preferred:

- `Write something`
- `Added to Shopping`
- `Updated Push Workout`
- `Original preserved`
- `Undo available`
- `Needs your input`
- `Saved offline. We'll organize it when you're connected.`

Avoid:

- `Let the magic begin`
- `Your AI brain has organized this`
- `Unfiled thinks you might want...`
- `Success!` without saying what succeeded
- false privacy, encryption, or automation claims

Use `Unfiled` as a product name, not as a speaking character. Prefer `Added to Shopping` over `Unfiled added this to Shopping`.

## 13. Asset manifest

| Asset                                             | Purpose                                            |
| ------------------------------------------------- | -------------------------------------------------- |
| `design/brand/unfiled-brand-board-v1.png`         | identity overview and visual-world reference       |
| `design/brand/mobile/01-lock-screen.png`          | Lock Screen quick-capture reference                |
| `design/brand/mobile/02-quick-capture.png`        | focused mobile composer                            |
| `design/brand/mobile/03-today.png`                | mobile receipt ledger                              |
| `design/brand/mobile/04-notes-library.png`        | manual note navigation                             |
| `design/brand/mobile/05-shopping-note.png`        | structured note detail                             |
| `design/brand/mobile/06-review.png`               | ambiguous-routing review                           |
| `design/brand/web/01-hero.png`–`06-final-cta.png` | six public marketing sections                      |
| `design/brand/web/07-authenticated-app.png`       | signed-in desktop product                          |
| `design/brand/vector/`                            | working SVG mark, monochrome, and app-icon sources |
| `design/brand/GENERATION_PROMPTS.md`              | normalized reproducible image-generation brief     |

## 14. Production handoff checklist

- [ ] Complete launch-name legal and channel clearance.
- [ ] Optically correct the working SVG symbol and draw the final wordmark as production SVG/PDF masters.
- [ ] Test the simplified symbol at 16, 20, 24, 32, and 48 px.
- [ ] Build app icon and WidgetKit monochrome/template variants.
- [ ] Record contrast ratios and color-blind/state checks.
- [ ] Implement shared tokens in `packages/design-tokens` for web and native.
- [ ] Replace any sparkle/head/folder artifacts from generated concepts.
- [ ] Validate all mobile screens at 320 pt width, keyboard open, and 200% Dynamic Type.
- [ ] Validate web layouts at 640, 1024, and 1440 px plus keyboard-only navigation.
- [ ] Run the six-section homepage through performance, responsive, and reduced-motion checks.
- [ ] Conduct five-person capture/routing usability study before freezing Milestone 0.
