TRIAGE REPORT

## What happens

People at the customer's company are sent back to the sign-in page after signing in with single sign-on.

## Where

Sign-in, SSO only. The identity provider's response carries `audience=https://app.example.com/saml`, while the workspace expects `https://app.example.com/sso/saml`; `validateAssertion()` rejects it and logs `null` for the session.

## Why

The address set in the customer's identity provider for this app does not match the one the workspace expects, so every sign-in is turned away.

## Scope

Only this customer's workspace; other workspaces sign in normally. Configuration, not a defect: the harness passes once the address matches.

## Workaround

None found.

## Confidence

Medium — the mismatch is visible in the sign-in logs, but the harness could not use the customer's own identity provider.
