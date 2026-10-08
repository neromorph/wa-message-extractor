# wa-message-extractor

Secure, production-ready, **read-only** WhatsApp message extractor CLI.
Authenticates via Baileys, fetches history inside a time window, prints JSON
to stdout, exits. Packaged as a rootless distroless image for VPS cron runs.
Extracted messages are routed to a Telegram topic (via Hermes).

## How it works

```
Authenticate → fetch history within window → JSON to stdout → exit
```

- One WhatsApp connection serves all targets (`--all` does not reconnect per target).
- History sync stops on `messaging-history.status: complete` + 3s settle,
  3s of chunk silence, or the `--wait` hard cap (default 30s) — whichever
  comes first. `meta.history_sync.stopped_by` tells you which fired.
- `syncFullHistory: false`: WhatsApp delivers RECENT chunks only, never months.
- JSON goes to **stdout only**. Logs, QR codes and progress go to **stderr**.
  Pretty-printed on a TTY, compact when piped.
- Exit codes: `0` OK (or PARTIAL) · `1` ERROR · `2` NEEDS_AUTH ·
  `3` PARTIAL with `--strict`. Invariant: **nonzero exit ⇔ no usable JSON**.
- A global watchdog (default 120s, `--timeout`) and SIGINT/SIGTERM handlers
  guarantee cron can never hang.

## Read-only guarantee

Three layers, not a promise:

1. The raw Baileys socket never leaves the connector — app code holds a
   narrow handle. What the app cannot reach, it cannot call.
2. That handle is a `Proxy` that throws on ~40 mutating methods
   (`sendMessage`, `readMessages`, `chatModify`, `logout`, group admin,
   profile edits, …). Dynamic dispatch (`sock[fn]()`) throws too.
3. `wa-readonly/no-whatsapp-mutation` (project oxlint plugin) flags direct
   mutating call sites at lint time and fails CI.

The app also sets `markOnlineOnConnect: false`, never calls `logout()`,
and never deletes credentials. One honest caveat: WhatsApp Multi-Device
requires protocol-level delivery receipts (`inactive`/`hist_sync`) to sync
at all — those still go out. No blue ticks, no online presence, no replies.

> **Account risk.** Baileys is unofficial and WhatsApp may restrict numbers
> that use it. Link a **secondary number**, not your primary.

## Quick start (local)

Requires Node.js ≥ 24.

```bash
npm install
cp targets.json my-targets.json  # actually: edit targets.json in place
```

Edit `targets.json`:

```json
{
  "targets": [
    { "alias": "devops-team", "name": "DevOps Team", "jid": "120363xxxxxxxxx@g.us", "enabled": true },
    { "alias": "tech-lead", "name": "Tech Lead Direct", "jid": "628123xxxxxxx@s.whatsapp.net", "enabled": true }
  ]
}
```

> Do not commit real JIDs to a public repo. The shipped file carries
> obvious placeholders.

First run — interactive QR auth (needs a TTY):

```bash
node index.js --target devops-team --auth-dir ./auth_info
# scan the QR under WhatsApp → Settings → Linked devices
```

Then:

```bash
node index.js --target devops-team --window 60 --auth-dir ./auth_info | jq .
node index.js --jid '628123xxxxxxx@s.whatsapp.net' --window 30 --auth-dir ./auth_info
node index.js --all --window 60 --auth-dir ./auth_info
```

## CLI reference

| Flag | Default | Meaning |
|---|---|---|
| `--target <alias>` | — | one alias from `targets.json` |
| `--jid <jid>` | — | one direct JID (works with no `targets.json`) |
| `--all` | — | all `enabled` targets (one connection) |
| `--window <minutes>` | `60` | rolling window, ends at connect time |
| `--wait <seconds>` | `30` | max wait for history sync |
| `--timeout <seconds>` | `120` | global watchdog |
| `--auth-dir <path>` | `/app/auth_info` | Baileys credentials |
| `--topic <name>` | `general` | Telegram topic for routing intent |
| `--list-groups` | — | list all participating groups (JID + name) as JSON and exit |
| `--auth` | — | authenticate only: scan QR, save creds, exit |
| `--strict` | off | exit 3 when any result is PARTIAL |

Exactly one of `--target` / `--jid` / `--all` / `--list-groups` is required.

## Finding your JIDs

- **DMs**: the phone number in international format + `@s.whatsapp.net`
  (e.g. `628123xxxxxxx@s.whatsapp.net`).
- **Groups**: the JID is not shown in the app. After QR auth, list them:
  ```bash
  node index.js --list-groups --auth-dir ./auth_info | jq .
  # {"status":"OK","groups":[{"jid":"120363xxxxxxxxx@g.us","name":"DevOps Team","participants":12}]}
  ```
  Copy the `jid` into `targets.json`. `--list-groups` opens no history sync
  and needs no `targets.json`.

Output (single target):

```json
{
  "status": "OK",
  "meta": {
    "target_alias": "devops-team",
    "destination_telegram_topic": "general",
    "time_window_minutes": 60,
    "extracted_at": "2026-10-07T12:30:00.000Z",
    "total_messages": 1,
    "history_sync": {
      "chunks_received": 3,
      "messages_seen": 12,
      "sync_types": ["RECENT"],
      "completed_explicitly": true,
      "stopped_by": "status"
    }
  },
  "messages": [
    {
      "sender_jid": "628123456789@s.whatsapp.net",
      "sender_name": "DevOps Engineer",
      "from_me": false,
      "timestamp": "2026-10-07T12:15:00.000Z",
      "text": "OKD cluster endpoint verification completed.",
      "message_type": "text"
    }
  ]
}
```

`--all` returns an envelope: `{status, meta:{target_count, total_messages, …}, results:[…]}`.
No session: `{"status":"NEEDS_AUTH","message":"Run interactively to scan QR code."}` (exit 2).
Non-text messages (image, audio, sticker…) are included with `text: null`
( Captions only — media is never downloaded) and a `message_type` tag.
Sender names resolve `pushName` → saved contact → group participant → JID.

`total_messages: 0` means "nothing in the window **that WhatsApp synced**",
not provable silence — check `history_sync` (`stopped_by: "cap"` degrades
the result to `PARTIAL`). Live RECENT-sync messages also arm the settle
timer, so upsert-fed runs finish `silence` → `OK`; only a fully quiet
window (no history, no live messages) still caps to `PARTIAL`.

## Docker

```bash
docker compose build
# first run: interactive QR (needs a TTY), creds land in the wa_auth_data volume
docker compose run --rm extractor --target devops-team --window 60
# routine runs
docker compose run --rm extractor --all --window 60 | jq .
```

Image: `neromorph/wa-message-extractor`. Multi-stage build
(`node:24-trixie-slim` → `gcr.io/distroless/nodejs24-debian13:nonroot`),
runs as UID 65532, `read_only: true`, `cap_drop: ALL`,
`no-new-privileges`, `targets.json` mounted `:ro`, auth in a named volume
pre-seeded with the right ownership (see ADR-002 in the vault).

## Hermes cron → Telegram topic

Topology: host cron runs the extractor, Hermes only reads. (A gate script
inside Hermes cannot run containers — the Hermes image ships no Docker
socket.) Full wiring, as deployed: vault note `Hermes Wiring Wa-Hourly`.

```cron
# host crontab — daytime only (07:05–21:05 WIB); exit code captured for the gate
5 0 * * *    flock -n /tmp/wa-extract.lock sh -c 'cd /home/mufid/wa-message-extractor && docker compose run --rm extractor --all --window 660 --topic Merkle > out/latest.json 2> out/last-stderr.log; echo $? > out/last-exit'
5 1-14 * * * flock -n /tmp/wa-extract.lock sh -c 'cd /home/mufid/wa-message-extractor && docker compose run --rm extractor --all --window 60 --topic Merkle > out/latest.json 2> out/last-stderr.log; echo $? > out/last-exit'
```

- Share one read-only bind with Hermes:
  `/home/mufid/wa-message-extractor/out:/opt/data/wa-out:ro`.
- Gate `wa-gate.py` (in Hermes `$HERMES_HOME/scripts`): exit `1`/`2` →
  alert with 6h cooldown, `0` + zero messages → silent, `0` + messages →
  wake with counts. State file is best-effort (never crash the gate);
  install and test only as the `hermes` user — root-created files break
  the next real tick (vault: incident 2026-10-07). Job `wa-merkle`:
  LLM-driven, `--continuity`, schedule `10 0-14 * * *` UTC (digest lands
  `:10`, five minutes after extraction finishes), failures to a
  separate DM via `--failure-deliver`.
- `targets.json` is the group registry — re-read every run, no restart.
  13 targets → Merkle (12 work groups + `self`). First run of the day
  uses `--window 660` as an overnight catch-up; caveat: warm-session probe
  returned `stopped_by: cap` + 0 messages, so the catch-up only proves
  itself on a real cold morning run — verdict pending.

## Quality gates

| Gate | Command | Where |
|---|---|---|
| Lint (oxlint + anti-slop + read-only rule) | `npm run lint` | pre-commit, CI |
| Tests (`node:test`, no deps) | `npm test` | pre-commit, CI |
| Both | `npm run verify` | `.husky/pre-commit` |
| Trivy fs (vuln+secret+misconfig) | `npm run security` | CI (+ manual) |
| Trivy image + SBOM | CI only | CI `build` job |
| Compose hardening assertion | `docker compose config` + `jq -e` | CI |

Pre-commit runs automatically after `npm install` (Husky `prepare` hook).
Trivy is deliberately **not** in the hook — it needs its DB and network.

Reproduce CI locally:

```bash
npm run verify
./tools/security-scan.sh            # needs trivy + a local image build
docker compose config --format json | jq -e '.services.extractor.read_only == true'
```

## Releases & deploy

- Push to `main` → build, scan, push `:edge` + `:sha-xxxxxxx` (no deploy).
- Tag `v*` → push `:X.Y.Z`, `:X.Y`, `:latest`. No auto-deploy: pull manually.
- Deploy (manual, on the VPS):
  ```bash
  cd ~/wa-message-extractor
  git pull --ff-only
  docker compose pull
  ```
- Rollback: re-tag an older `:sha-xxxxxxx`, or `git checkout vX` + `compose pull`.
- Secrets: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`. Third-party actions are SHA-pinned.

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `NEEDS_AUTH` (exit 2) | no `creds.json` and no TTY → run once with a TTY to scan QR |
| `Poisoned session quarantined …` (exit 1) | 401 on creds that never logged in → backup named in message, re-pair with `--auth` |
| `creds.json` is 0 bytes | killed mid-write by an early exit (fixed: flush before exit) → auto-quarantined next run, re-pair |
| `logged out (401)` | session revoked → delete auth dir contents, rescan (never automatic) |
| `EISDIR` on targets.json | host file missing so Docker made a dir → create `./targets.json` |
| `PARTIAL` / `stopped_by: "cap"` | slow sync → raise `--wait`, check phone connectivity |
| QR expires | re-run; scan within ~60s |
| `read-only violation` in logs | a code path touched a mutating method → file a bug, nothing was sent |

Project notes, ADRs and runbooks live in the (private) obsidian vault
`~/personal-projects/obsidian-vaults/wa-message-extractor/`.
Infra details (`AGENTS.md`) are never committed — this repo is public (MIT).

## License

MIT. Note: the dependency tree contains GPL-3.0 code (`libsignal`,
transitive via Baileys) — fine for running and private use, check with
counsel before embedding this tool in a closed-source product.
