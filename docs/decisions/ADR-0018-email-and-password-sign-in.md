# ADR-0018: Email and password sign-in

Status: accepted (2026-09-02). Supersedes the passwordless sign-in described in ADR-0001 and the
Milestone B auth contracts.

## Context

The product signed users in with a six-digit emailed code. On the deployed free beta that flow was
unusable: Supabase's built-in mailer delivers only to organization members, allows two authentication
emails per hour for the whole project, and cannot render the code without custom SMTP. The owner
rejected codes outright and asked for a conventional password sign-in with no verification step.

## Decision

- Accounts are created with an email address and a password (8 to 72 characters) and receive a
  session immediately; Supabase "Confirm email" is off for the beta.
- Sign-in is email and password. There is no emailed code anywhere in the product.
- The API exposes `POST /api/v1/auth/sign-up` and `POST /api/v1/auth/sign-in`; the code endpoints
  are removed. Refresh, session, and sign-out are unchanged.
- The hourly attempt quota applies to every sign-up and to every rejected sign-in; successful
  sign-ins never consume it. Supabase's own throttle covers credential stuffing until a dedicated
  sign-in limiter lands.
- Password reset is not built; the owner resets beta passwords from the Supabase dashboard.

## Consequences

- No SMTP is needed for sign-in or sign-up.
- Synthetic verification creates confirmed users with passwords through the Auth admin API.
- Password recovery and a dedicated sign-in limiter are the next auth items on the roadmap.
