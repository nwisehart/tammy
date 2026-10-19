# Running Tammy

Tammy is one Node process: a Slack Socket Mode connection, a small HTTP server
for Prepcook's webhook, and one SQLite file. It needs Node 22 or later; most
of its memory is the embedding model, loaded on the first search.

## As a service

Build once, then run `dist/index.js`:

```sh
pnpm install --frozen-lockfile
pnpm build
node dist/index.js --config /etc/tammy/tammy.toml
```

`pnpm start` does both, for a checkout. A systemd unit:

```ini
# /etc/systemd/system/tammy.service
[Unit]
Description=Tammy, the Slack agent in front of Prepcook
After=network-online.target
Wants=network-online.target

[Service]
User=tammy
WorkingDirectory=/opt/tammy
ExecStart=/usr/bin/node dist/index.js --config /etc/tammy/tammy.toml
Environment=TAMMY_SECRETS_FILE=/etc/tammy/secrets.env
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/etc/tammy/secrets.env` must be owned by `tammy` and mode `0600`. On SIGINT or
SIGTERM Tammy stops taking deliveries, finishes the ones in hand, disconnects
from Slack and closes the database. Exit code `2` means a configuration
problem (the log says which key or secret); `1` anything else.

Re-index after the docs change, from a timer, a CI job or a hook:

```sh
node dist/cli.js index --config /etc/tammy/tammy.toml
```

It is safe while Tammy runs: SQLite serialises the writes, and each
document is swapped in one transaction. `tammy index --watch` does it
continuously for local sources.

## API key or seat

Both ways of reaching Claude ([setup.md](setup.md#claude-api-key-or-seat))
give the same answers; they differ in how they fail and what they cost.

- **The API key** (`provider = "api"`) is for a service that must not pause.
  It is billed per token, has no usage window, and each message is a few
  HTTPS requests from the Tammy process.
- **The seat** (`provider = "seat"`) is for heavy use on a subscription the
  team already has. It costs nothing extra per message, but it shares the
  seat's usage windows with anything else signed in to it, and when a window
  runs out Tammy pauses — a holding reply to customers, an alert to the team
  — until it resets. Give her a login of her own (`claude_config_dir`) so
  someone's day of coding does not use up her window, or hers theirs.

The seat runs the `claude` CLI as a child process for each call: one for the
classifier and one for the answer to every message, and one for each report
she explains. Each start adds a second or two and some memory while it runs;
several messages at once mean several processes. The CLI must be installed
for the user the service runs as, and that user must have signed in; with
systemd, sign in as that user (`sudo -u tammy env
CLAUDE_CONFIG_DIR=/var/lib/tammy/claude claude /login`) and, if `claude` is
not on the unit's PATH, set `claude_binary` to its full path. Upgrading Claude
Code is upgrading Tammy's model client: check `claude --version` after one.

## The data directory

`data_dir` (default `data/`, beside `tammy.toml`):

| Path                            | What                                                                                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tammy.db` (and `-wal`, `-shm`) | The menu index (documents, chunks, vectors), the orders she filed with their Slack threads, the conversations she is in, and the webhook deliveries already handled. |
| `models/`                       | The embedding model, downloaded by `tammy index`. Can always be fetched again.                                                                                       |
| `seat-cwd/`                     | With the seat: the empty directory the `claude` CLI runs in. Nothing is kept there.                                                                                  |

`tammy.db` is the only state worth keeping. Lose the menu and `tammy index`
rebuilds it; lose the orders and reports that come back for earlier cards no
longer find their threads.

## Logs

One line per event on stderr, `<time> <level> <scope>: <message>`, which
journald and most service managers keep as they are. `log_level` (or
`TAMMY_LOG_LEVEL`) sets the threshold: `info` logs what she did with each
message (`question`, `problem_report, filed PC-42`), each report she explained
and each conversion; `debug` adds the tools she was offered, every event she
ignored, and each message's token use (`api: 1520 in / 210 out tokens this
turn`; the seat adds the CLI's cost estimate). When Claude is unavailable —
the seat signed out, its usage window used up, or the `claude` CLI missing —
every affected message logs one `error` line saying which and what to do,
and the team channel hears it at most once an hour. No line carries a secret, and message text is not logged.

```sh
journalctl -u tammy -f
```

## Health

`GET /health` on the webhook port answers `200 {"status":"ok"}` while the
process is up. It does not check Slack; the log says when the Socket Mode
connection drops and reconnects.

## Backups

SQLite in WAL mode: copy the file with SQLite's own backup, not `cp`, while
Tammy runs.

```sh
sqlite3 /opt/tammy/data/tammy.db ".backup '/backups/tammy-$(date +%F).db'"
```

Or stop the service, copy `tammy.db` (after a clean stop the `-wal` file is
empty), and start it again. To restore, stop Tammy, put the copy in place as
`tammy.db`, delete any `tammy.db-wal` and `tammy.db-shm` beside it, and start.

## When Tammy was down

Prepcook retries a failed delivery three times within about four seconds, and
then gives up. A report that arrived while Tammy was down is not posted by
itself: the card stays **Triaged** on the board and the order stays open in
Tammy's database. Asked in the thread, she can tell the customer the team has
finished looking (`check_order` reads the card), and the team sees it in
`/tammy status PC-42`, but the explanation itself has to be passed on by
someone on the team. Keep the outage short, or watch the Triaged column while
it lasts.

## Upgrading

Stop, install, build, start. The database migrates itself on open. When an
upgrade changes the embedding model, the server refuses to search until
`tammy index` has rebuilt the menu, so run it straight after.
