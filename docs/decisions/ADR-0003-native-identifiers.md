# ADR-0003: Immutable native application identifiers

- Status: accepted; generation mechanism updated by ADR-0010
- Date: 2026-08-30
- Last updated: 2026-08-31
- Decision drivers: Apple identifiers become difficult to change after credentials and App Store records exist; development, preview, and production builds must coexist; the Lock Screen extension and host app must share an explicit App Group.

## Context

The native SwiftUI client contains an iPhone application and a WidgetKit extension. Apple signing requires the host bundle identifier, extension bundle identifier, and App Group identifier to match registered values exactly. The original planning examples used a generic namespace that was not tied to a controlled reverse-DNS identity.

## Decision

Use the following production identifiers:

- host application: `com.zachshotamartin.unfiled`
- widget extension: `com.zachshotamartin.unfiled.quickcapture`
- App Group: `group.com.zachshotamartin.unfiled`
- URL scheme: `unfiled`

Development appends `.dev` to the host and App Group identifiers and uses `unfiled-dev`. Preview appends `.preview` and uses `unfiled-preview`. The widget identifier is always the selected host identifier followed by `.quickcapture`.

`apps/ios/Config/Development.xcconfig`, `Preview.xcconfig`, and `Production.xcconfig` are the environment source of truth. `apps/ios/project.yml` maps those values into the application and extension targets. XcodeGen produces `apps/ios/Unfiled.xcodeproj`; contributors regenerate it and never repair identifier drift with hand edits to the generated project.

## Alternatives considered

- `app.unfiled.mobile`: concise, but not tied to the developer's reverse-DNS namespace and already diverged from the selected Apple records.
- One identifier for every environment: simpler configuration, but prevents multiple variants from coexisting on a device and risks signing the wrong App Group.
- A hand-maintained project file: superficially direct, but makes target membership and environment drift harder to review. Declarative XcodeGen input is deterministic and diffable.

## Consequences

Apple App IDs, App Groups, provisioning profiles, associated domains, and App Store records must use these exact identifiers. A future legal rename may change display name and marketing domain without changing them. Changing an identifier requires a superseding ADR and new Apple records. Unsigned simulator CI validates build structure, not Apple Developer registration, provisioning, entitlements on a signed archive, or App Group behavior on hardware; those remain explicit human gates.

## Superseded history

The first version sourced variants from the former cross-platform client configuration. ADR-0010 retired that client. The identifier values survived; only their canonical configuration and generation path changed.
