<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/tammy-logo-dark.svg">
    <img src="assets/brand/tammy-logo.svg" alt="Tammy" width="290">
  </picture>
</p>

If Prepcook is the prep cook, Tammy is the waitress. She works in Slack. She
knows the menu — your product's documentation — by heart and answers customers
from it, with the passage she used. When a customer reports something that
looks broken, she takes the order to the kitchen: she asks the questions an
engineer would ask, files an **investigation card** on
[Prepcook](https://github.com/nwisehart/prepcook), waits for its triage
report, and explains it to the customer in plain English. She never fixes
anything, never promises a fix, never speaks for the engineers beyond what the
report says, and never turns an investigation into a bug because a customer
asked; someone on the team can.

## Quickstart

This takes one question and one bug report through Tammy, on Pantry, Prepcook's
demo app. It assumes Prepcook is already running with the Pantry demo:
the Prepcook README's Quickstart steps 1 to 3 (Prepcook up, the
`prepcook-demo` repository added, a `Pantry` board with the orchestrator on
and the repository ticked). You also need Node 22 or later, pnpm 10, a Slack
workspace where you can install apps, an Anthropic API key (or a Claude
subscription; see [API key or seat](#api-key-or-seat)), and a clone of
`prepcook-demo` beside this repository (`../prepcook-demo`).

Your own steps take under 30 minutes. Prepcook's investigation comes on top:
10 to 20 minutes of Plan, the same as for any bug.

### 1. Create the Slack app (about 8 minutes)

Create an app **from a manifest** at
[api.slack.com/apps](https://api.slack.com/apps) with the manifest in
[docs/setup.md](docs/setup.md#1-the-slack-app). It runs in Socket Mode, so no
public URL is needed. Then generate an app-level token with
`connections:write` (`xapp-…`), install the app to the workspace (the bot
token, `xoxb-…`), and make two channels: `#pantry-help` for customers and
`#pantry-team` for the team. Invite Tammy to both (`/invite @Tammy`).

### 2. Connect Prepcook (about 4 minutes)

Choose two long random values, one for the card API and one for the webhook
signature, and give them to Prepcook:

```sh
prepcook secret set PREPCOOK_API_TOKEN
prepcook secret set WEBHOOK_SECRET
```

Then add a notification target in Prepcook, **Settings → Integrations →
Notifications → Add target → Webhook**:

| Field  | Value                                       |
| ------ | ------------------------------------------- |
| URL    | `http://127.0.0.1:3978/prepcook/webhook`    |
| Events | `investigation_completed`, `card_converted` |

(In `config.json` that is
`{ "kind": "webhook", "url": "http://127.0.0.1:3978/prepcook/webhook", "events": ["investigation_completed", "card_converted"] }`;
the signing secret comes from `WEBHOOK_SECRET`.)

### 3. Configure Tammy (about 5 minutes)

```sh
pnpm install
cp tammy.example.toml tammy.toml
```

In `tammy.toml`, put the two channel ids under `[slack]`
(`customer_channels = ["<#pantry-help id>"]`, `internal_channels` and
`notify_channel` = the `#pantry-team` id). The rest of the example already
fits the demo: `product = "Pantry"`, the menu at `../prepcook-demo/docs`, and
Prepcook at `http://localhost:4100`. Then the secrets, in a file only you can
read:

```sh
mkdir -p ~/.config/tammy
install -m 600 /dev/null ~/.config/tammy/secrets.env
```

```sh
TAMMY_SLACK_BOT_TOKEN=xoxb-…
TAMMY_SLACK_APP_TOKEN=xapp-…
ANTHROPIC_API_KEY=sk-ant-…
PREPCOOK_API_TOKEN=<the same value Prepcook has>
TAMMY_WEBHOOK_SECRET=<the same value as WEBHOOK_SECRET>
```

`brain.model` is `claude-sonnet-4-5`; change it if your account offers a model
you prefer.

### 4. Index the menu (about 2 minutes)

```sh
pnpm tammy index ../prepcook-demo/docs
pnpm tammy ask "how do I share a list"
```

The first run downloads the embedding model (about 25 MB) into `data/models`;
indexing Pantry's six pages then takes seconds. `tammy ask` prints the
passages Tammy would read for the question, best first, with their scores and
citations, and then her answer. It goes nowhere near Slack or Prepcook.

### 5. Start her and ask a question (about 2 minutes)

```sh
pnpm start
```

The log says `connected to Slack (Socket Mode)` and `webhook listening on
http://127.0.0.1:3978/prepcook/webhook`. In `#pantry-help`:

> **@Tammy** how do I share a list?

She replies in a thread — "_Tammy is writing…_", edited into the answer a few
seconds later — with the steps from Pantry's sharing page and _From the menu:
Sharing a list with someone_ underneath.

### 6. Report the bug (about 4 minutes, then 10 to 20 waiting)

Start a new thread in `#pantry-help`, as a customer would:

> **@Tammy** I'm trying to share our Weekend list with Ann. I type
> Ann@Example.com and it says "No user with that email", but she definitely has
> an account, she signs in every day!

Tammy checks the menu first, and may point out what it says about that message
(check the address for typos, use the one they sign in with). Say it is the
address Ann signs in with. Now it is a problem the menu does not explain, so
she asks, once and numbered, for what she is missing — the steps, what you
expected, whether it happens every time. Answer in the thread, in your own
words ("Open Weekend, type Ann@Example.com under Share, press Share. It should
be shared. Every time — but lower case seemed to work once?").

She files the investigation card and says she has taken it to the kitchen. The
card's link is in her reply, and `#pantry-team` gets "New order PC-… : …" with
the same link and the thread. On the board the card is in **Plan**, tagged
`investigation`, "Filed by Tammy".

Then Prepcook works it exactly as it works a bug's Plan: it stands Pantry up,
writes a harness that shares the list with `Ann@Example.com`, watches it fail,
finds the cause and posts a `TRIAGE REPORT`. Allow 10 to 20 minutes. This is
the step that depends on Prepcook's planning stage, and its time is Plan's:
the model, the machine and the first Playwright download all count. If no
agent picks the card up within a minute, the orchestrator is off or the board
is not automated; if the board has no Triaged column, the finished card stays
in Plan tagged `needs-column` and no report is sent until you add one.

When the report is in, the card moves to **Triaged**, Prepcook sends
`investigation_completed`, and Tammy posts in the customer's thread. For this
bug it typically says what happens and why (the address is matched exactly as
typed, so a capital letter misses), that it is on our side and not their setup, that in the meantime they
can type the address in lower case, and that the team has the details. No
paths, no code, no promises. `#pantry-team` gets the short version: the card
link, the confidence, whether the reproduction failed as reported, and the
command to have it fixed.

If you are trying this alone and you are in `#pantry-team`, Tammy counts you
as the team everywhere. @-mention her in every reply in the customer thread:
a team member writing there without mentioning her takes the thread over and
she steps aside.

### 7. Have it fixed (1 minute)

In `#pantry-team`, someone on the team runs:

```
/tammy convert PC-12
```

with the card's key. Tammy converts the card through Prepcook's API (as a
customer, the same command is refused and nothing is sent). With the
investigation's analysis at high confidence and its harness still on disk, the
card goes straight to **Execute** and Prepcook starts the fix; otherwise it
goes back to **Plan** to be planned as a bug. Prepcook sends `card_converted`,
and Tammy tells the customer's thread the kitchen has taken this on as a bug —
without a date. From there it is Prepcook's Quickstart step 4.

### API key or seat

The quickstart uses an Anthropic API key. Tammy can instead run on a Claude
subscription the team already pays for: sign in on the host with
`claude /login` (ideally into a login of her own,
`CLAUDE_CONFIG_DIR=~/.config/tammy/claude claude /login`), set
`[brain] provider = "seat"` and `claude_config_dir` to match, and leave
`ANTHROPIC_API_KEY` out. She then reaches Claude through the `claude` CLI and
the Claude Agent SDK, with every built-in tool switched off so the model
gets her four tools and no file or shell access. The trade-off is the
subscription's usage windows: when one runs out she tells customers she can't
answer right now, tells the team, and resumes when it resets. Use the API key
for a service that must not pause. [docs/setup.md](docs/setup.md#claude-api-key-or-seat)

## How it works

**The menu.** `tammy index` reads the documentation — local Markdown, text,
HTML and PDF, or web pages crawled from a start URL on one origin — splits it
at its headings into chunks of about 500 tokens, embeds each one locally with
a small sentence model (Anthropic has no embeddings API), and stores them in
SQLite with `sqlite-vec`. Re-running it re-embeds only what changed. At answer
time a search is one local query; nothing goes online.
[docs/menu.md](docs/menu.md)

**The brain.** Each Slack message is first sorted by Claude into a question, a
problem report or other. That decides the tools the answer is offered:
`search_menu` for a question; `search_menu`, `ask_customer` and
`file_investigation` for a problem; and `check_order` when the thread already
has an order. One system prompt sets her voice: warm, brief, plain, from the
menu with citations, "I don't know" when the menu is thin.
[docs/persona.md](docs/persona.md)

**The kitchen.** `file_investigation` posts an investigation card to Prepcook's
card API (`work_class: investigation`, `start: true`) with the report
in the customer's words, the thread quoted, its permalink as the origin and
any attached files as links. The card id and the Slack thread are kept
together in Tammy's SQLite file.

**The report.** Prepcook signs each webhook delivery with HMAC-SHA256; Tammy
verifies the signature over the raw body, drops repeated deliveries, and
answers at once. An `investigation_completed` report is rewritten for the
customer by Claude from a fixed brief, then filtered — any sentence with a
stack trace, a path, code or internal jargon is dropped — and posted in the
thread; `card_converted` becomes one line in the thread. Everything else is
ignored.

**Who is who.** Members of the internal channels (or listed user ids) are the
team. Only they can convert a card, and when one of them writes in a
customer's thread, Tammy steps aside.

[docs/setup.md](docs/setup.md) covers the Slack app, Prepcook's side and the
configuration; [docs/operations.md](docs/operations.md) running her as a
service, logs and backups.

## Layout

```
src/index.ts          boot: config, the menu, Bolt (Socket Mode) and the webhook server
src/cli.ts            tammy index | ask | start
src/config.ts         tammy.toml, the environment and the secrets file
src/menu/             sources, chunking, embeddings, the SQLite index, retrieval
src/brain/            the persona, the classifier, the tools, and the API and seat providers
src/slack/            the Bolt handlers, threads and placeholders, /tammy, formatting
src/kitchen/          Prepcook's card API, and the orders table
src/webhook/          POST /prepcook/webhook: signature, de-duplication, events
src/plain-english/    triage report → customer message, and its fixtures
test/                 Vitest, against fake Slack, Claude and Prepcook
assets/brand/         the mark and logo (python3 assets/brand/build.py)
```

## Development

```sh
pnpm install
pnpm dev                 # tsx watch src/index.ts
pnpm test                # Vitest; nothing reaches Slack, Claude or Prepcook
pnpm lint                # ESLint and tsc
pnpm format              # Prettier
pnpm build               # dist/
```

For trying her out without the model download, set
`menu.embeddings.model = "builtin:hash"`: a word-hashing embedder that needs
nothing but finds passages by shared words rather than meaning.

## License

Apache License 2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
