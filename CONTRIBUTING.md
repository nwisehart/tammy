# Contributing to Tammy

Thanks for helping. Tammy is small enough that one person reads every pull
request, so keep changes focused and say what they are for.

## Before you start

- Open an issue for anything bigger than a bug fix, so the shape can be
  agreed before the code is written.
- Write the name as **Tammy** in prose and in Slack, and `tammy` in code, the
  CLI and paths (`tammy.toml`); environment variables take the `TAMMY_`
  prefix, except the two she shares with other tools (`ANTHROPIC_API_KEY`,
  `PREPCOOK_API_TOKEN`). In prose the product Tammy talks to is **Prepcook**,
  one word with only the P capitalised.

## Pull requests

1. Branch from `main`.
2. Keep the change to one topic. A refactor and a feature are two pull
   requests.
3. Run `pnpm format`, `pnpm lint`, `pnpm build` and `pnpm test` before you
   push.
4. Add or update tests for behaviour you change. Tests never reach the
   network: Slack, Claude and Prepcook are fakes (`test/helpers.ts`), and the
   menu is embedded with the built-in word-hashing embedder.
5. Write comments that read cold: document the current behaviour and the
   constraint behind it, never the change that produced it or the ticket it
   came from.
6. Describe in the pull request what changed, why, and how you verified it.

## Tammy's voice

What Tammy says is part of the product. The persona lives in
`src/brain/prompts.ts`, the report translation in
`src/plain-english/translate.ts`, and the human-readable version of both in
[docs/persona.md](docs/persona.md): change them together. A change to a prompt
needs the same care as a code change — say what you observed before and
after, with the conversation that shows it.

Two rules are not up for a prompt tweak, and each has a test: Tammy never
converts a card from a conversation, and nothing from a triage report reaches
a customer without going through `sanitize` (no stack traces, file paths, code
or jargon from the denylist). A new kind of leak gets a fixture in
`src/plain-english/fixtures/` first.

## Prepcook's contract

Tammy relies on Prepcook's card API (`docs/api.md` in the Prepcook
repository) and its webhook events (`docs/notifications.md`). Those are
documented as stable; when one changes, update `src/kitchen/` or
`src/webhook/` and the fake Prepcook in `test/kitchen.test.ts` together.

## License

By contributing you agree that your contributions are licensed under the
Apache License, Version 2.0, the license of this project.
