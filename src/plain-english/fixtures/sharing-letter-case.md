TRIAGE REPORT

## What happens

Sharing a list with an email typed in a different letter case from the account's (`Ann@Example.com` for `ann@example.com`) fails with "No user with that email", and the list is not shared.

## Where

Lists → Share. `POST /lists/:listId/share` in `src/routes/sharing.js` finds the user with `u.email === email`, comparing the address exactly as typed. Sign-in (`src/routes/session.js`) lower-cases the address first, which is why Ann can still sign in.

## Why

Sign-in turns the address into lower case before it looks the person up, but sharing compares the address exactly as it was typed against the stored lower-case address, so any capital letter makes the lookup miss.

## Scope

Every account and every list: any share where the email is typed with a capital letter. A defect, not configuration: the harness fails on a fresh seed with the stock data.

## Workaround

Type the other person's email all in lower case (`ann@example.com`) when sharing.

## Confidence

High — reproduced on main (`.repro/PC-12/repro.mjs` fails as reported), and lower-casing the lookup makes the harness pass.
