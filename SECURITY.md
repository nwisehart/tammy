# Security

Tammy sits between your customers and your engineering team, with a Slack bot
token, a Prepcook API token and an Anthropic key. Treat it like any other
service that holds tokens and reads customer conversations.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's
private vulnerability reporting on this repository (Security → Report a
vulnerability). You will get an acknowledgement within a few days and a fix
or a mitigation as soon as one exists.

## What Tammy does with secrets

- The six secrets (`TAMMY_SLACK_BOT_TOKEN`, `TAMMY_SLACK_APP_TOKEN`,
  `TAMMY_SLACK_SIGNING_SECRET`, `ANTHROPIC_API_KEY`, `PREPCOOK_API_TOKEN`,
  `TAMMY_WEBHOOK_SECRET`) come from the environment or from a `KEY=VALUE`
  secrets file outside the repository. Tammy refuses to start when that file
  can be read by anyone but its owner (it must be mode `0600`). `tammy.toml`
  holds no secrets.
- Secret values never appear in a log line, an error message, a prompt, a
  Slack message or a Prepcook card. An error names the secret that is
  missing, never a value.
- Every webhook delivery must carry a valid `X-PrepCook-Signature` (HMAC-SHA256
  of the raw body with `TAMMY_WEBHOOK_SECRET`); anything else is refused with
  `401` before it is parsed. Deliveries are de-duplicated on
  `X-PrepCook-Delivery`.
- The webhook server listens on `127.0.0.1` by default. Expose it beyond the
  machine only behind TLS.

## What leaves the machine

- **To Anthropic:** the Slack thread Tammy is answering, the documentation
  passages she retrieved, and, when a report comes back, Prepcook's triage
  report.
- **To Prepcook:** for each problem she files, a summary in the customer's
  words, the last messages of the thread, the thread's permalink, the
  reporter's Slack display name, and links to files attached in the thread.
- **To Slack:** her answers, and short summaries with card links in the
  internal channel you configure.

The documentation index and its embedding model run locally; searching the
documentation sends nothing anywhere.

## Who can do what

Customers can ask questions, report problems and ask where their own reports
are. Converting an investigation into a bug — asking the engineers to fix it —
is refused for anyone who is not on the team (a member of an internal channel,
or listed in `slack.internal_users`), and the model has no tool that converts a
card at all.

## Supported versions

Only the latest release receives security fixes.
