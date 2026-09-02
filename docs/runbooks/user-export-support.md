# User Data-Export Support

## Scope and privacy boundary

The authenticated owner export is self-service and streams a human-readable archive. Support helps a
user operate that path; support does not generate, download, receive, inspect, email, or re-host an
archive. The archive may contain the user's full note content and must never enter a support system,
chat, analytics tool, log, shared drive, or ordinary attachment scanner.

## Authority

The support owner may provide instructions and inspect content-free request outcomes. Only the
authenticated owner can authorize and receive an export. There is no support impersonation,
service-role export, database dump, or server-side durable archive fallback.

The structured GitHub support template is a public, content-free intake path only after its branch
is merged to `main`. It is not a private account-data channel. If triage would require an email,
ownership evidence, export, token, or other private data, stop and establish an approved private
channel before continuing.

## Triage

1. Ask the user for the UTC time window, client platform/version, and the safe error code shown by
   the app. Do not ask for email, note titles/text, screenshots containing content, archive bytes,
   authorization/session values, or an account/deletion token.
2. Confirm service/deployment status and inspect aggregate export success/failure, safe error class,
   duration, and coarse byte bucket for that window. Do not search logs by owner ID.
3. Determine whether the failure is authentication, device storage/protection, network interruption,
   stream validation, server timeout, or account deletion in progress.
4. Check whether a general incident exists. For content/key exposure, stop and use
   [suspected key exposure](./suspected-key-exposure.md).

## User-safe recovery

1. Have the user sign in again through the normal client and start a fresh export from account
   settings on a trusted, unlocked device.
2. Instruct them to save it to a location they control and delete abandoned partial files. Native
   clients must remove protected temporary artifacts after share completion, cancellation, sign-out,
   or relaunch cleanup.
3. If the network failed after bytes began, start a new export. Do not concatenate, resume, or repair
   an unverified partial archive.
4. If an authenticated retry returns a validation/integrity error, stop retries and open an
   engineering incident. Never ask the user to bypass archive validation.
5. If deletion is pending or confirmed, follow [deletion reconciliation](./deletion-reconciliation.md).
   A confirmed deletion is not reversed to produce an export; export must precede deletion.

## Verification

Use a synthetic account to verify:

- streaming response is private/no-store with the exact expected archive media/disposition headers;
- the archive completes, passes integrity checks, and contains every synthetic fixture exactly once;
- interrupted/invalid output is removed and no server-side durable archive or plaintext log exists;
- sign-out and inactive-screen privacy protections remove or obscure the temporary artifact;
- unauthorized/cross-owner requests fail without revealing whether another account exists.

Do not use the user's archive for verification. If a fix is required, it passes automated export
completeness plus the synthetic Preview check before deployment.

## Stop, escalation, and evidence

Stop if support receives archive bytes/content, a server stores an archive, integrity cannot be
established, a cross-owner response is possible, or deletion state is ambiguous. Page security for
exposure; otherwise escalate to the release operator with only safe error/time/version information.

Record time window, client/deployment versions, safe failure class, aggregate impact, instructions
given, synthetic verification, temporary-artifact cleanup result, fix/release reference, and closure.
