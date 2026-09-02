# Signed iOS Archive and Device Evidence Template

## Candidate

- Commit SHA:
- Marketing version/build:
- Xcode/XcodeGen/Swift versions:
- Release scheme/configuration:
- Archive created UTC:
- Signing operator:
- Reviewer:

Do not record certificate private material, provisioning-profile payloads, Apple account identifiers, device UDIDs, tokens, or private App Store URLs.

## Archive inspection

| Check                                                 | State   | Safe observation |
| ----------------------------------------------------- | ------- | ---------------- |
| Archive SHA-256 recorded                              | pending |                  |
| Exactly one QuickCaptureWidget extension embedded     | pending |                  |
| Host/extension identifiers match ADR-0003             | pending |                  |
| Host and extension share the expected App Group       | pending |                  |
| Release API origin and URL scheme are correct         | pending |                  |
| Privacy manifests are present and reviewed            | pending |                  |
| SQLCipher GRDB resolved versions are reviewed         | pending |                  |
| No development secret or localhost origin is embedded | pending |                  |
| Code signatures and entitlements validate             | pending |                  |

## TestFlight

- App Store Connect record exists:
- Build processing result:
- Internal group delivery:
- Install/launch result:
- Crash/diagnostic review:

## Physical-device matrix

| Scenario                                               | Oldest supported iOS | Current iOS | State   |
| ------------------------------------------------------ | -------------------- | ----------- | ------- |
| Sign-in, relaunch, online/offline sign-out             |                      |             | pending |
| Offline save, force-quit, reconnect, exactly-once sync |                      |             | pending |
| Response-loss replay without duplication               |                      |             | pending |
| Expired-session queued capture resumes after sign-in   |                      |             | pending |
| Circular and rectangular Lock Screen controls          |                      |             | pending |
| Keyboard focus and Dynamic Type at 200%                |                      |             | pending |
| VoiceOver/reduced motion                               |                      |             | pending |
| App Group snapshot contains no content                 |                      |             | pending |
| Locked Keychain/SQLCipher denial then unlock recovery  |                      |             | pending |
| Deletion leaves no local ghost row                     |                      |             | pending |

## SQLCipher evidence

- Content-free cipher-version result:
- Database unreadable without device key:
- Upgrade/restart result:
- Reinstall/rehydration behavior:

## Result

- Archive SHA-256:
- Restricted archive/device evidence:
- State: pending
- Blockers:
- Reviewer sign-off:
