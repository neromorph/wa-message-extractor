# wa-message-extractor

Secure, production-ready, **read-only** WhatsApp message extractor CLI.
Authenticates via Baileys, fetches history inside a time window, prints JSON
to stdout, exits. Packaged as a rootless distroless image for VPS cron runs.
Extracted messages are routed to the Telegram topic **Merkle** (via Hermes).

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
    { "alias": "merkle-devops", "name": "Merkle DevOps Team", "jid": "120363xxxxxxxxx@g.us", "enabled": true },
    { "alias": "merkle-lead", "name": "Tech Lead Direct", "jid": "628123xxxxxxx@s.whatsapp.net", "enabled": true }
  ]
}
```

> Do not commit real JIDs to a public repo. The shipped file carries
> obvious placeholders.

First run — interactive QR auth (needs a TTY):

```bash
node index.js --target merkle-devops --auth-dir ./auth_info
# scan the QR under WhatsApp → Settings → Linked devices
```

Then:

```bash
node index.js --target merkle-devops --window 60 --auth-dir ./auth_info | jq .
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
| `--strict` | off | exit 3 when any result is PARTIAL |

Exactly one of `--target` / `--jid` / `--all` is required.

Output (single target):

```json
{
  "status": "OK",
  "meta": {
    "target_alias": "merkle-devops",
    "destination_telegram_topic": "Merkle",
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
the result to `PARTIAL`).

## Docker

```bash
docker compose build
# first run: interactive QR (needs a TTY), creds land in the wa_auth_data volume
docker compose run --rm extractor --target merkle-devops --window 60
# routine runs
docker compose run --rm extractor --all --window 60 | jq .
```

Image: `neromorph/wa-message-extractor`. Multi-stage build
(`node:24-trixie-slim` → `gcr.io/distroless/nodejs24-debian13:nonroot`),
runs as UID 65532, `read_only: true`, `cap_drop: ALL`,
`no-new-privileges`, `targets.json` mounted `:ro`, auth in a named volume
pre-seeded with the right ownership (see ADR-002 in the vault).

## Hermes cron → Telegram topic Merkle

Prereqs on the VPS: `mkdir -p ~/.hermes/scripts`, Hermes Telegram
connected, a forum topic named **Merkle** (long-press header → Copy link →
trailing integer is the thread id).

Gate script `~/.hermes/scripts/wa-merkle-gate.sh` (flock-guarded — two runs
must never share the auth volume):

```bash
#!/usr/bin/env bash
set -eu
OUT=/tmp/wa-merkle.json
flock -n /tmp/wa-merkle.lock \
  docker compose -f ~/wa-message-extractor/docker-compose.yml run --rm extractor --all --window 60 > "$OUT" 2>/dev/null || exit $?
TOTAL=$(jq -r '.meta.total_messages // 0' "$OUT")
STATUS=$(jq -r '.status' "$OUT")
if [ "$TOTAL" -gt 0 ]; then
  cp "$OUT" ~/.hermes/cron/output/wa-merkle-latest.json
  printf '{"wakeAgent": true, "context": {"status": "%s", "total_messages": %s, "file": "wa-merkle-latest.json"}}\n' "$STATUS" "$TOTAL"
else
  printf '{"wakeAgent": false}\n'
fi
```

Schedule an **LLM-driven** job with the gate attached (empty hours cost $0,
busy hours get a real summary in the Merkle topic):

```bash
hermes cron create "0 * * * *" \
  "Read ~/.hermes/cron/output/wa-merkle-latest.json and post a concise summary \
   of the new WhatsApp messages to the Merkle topic, flagging anything that needs action." \
  --script wa-merkle-gate.sh \
  --deliver telegram:<chat_id>:<thread_id> \
  --name wa-merkle-hourly
```

`--deliver telegram:<chat_id>:<thread_id>` addresses the Merkle topic
directly; alternatively set `TELEGRAM_CRON_THREAD_ID=<thread_id>` in the
Hermes `.env`. To silence the root chat entirely, enable Telegram topic mode
per the Hermes docs.

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
- Tag `v*` → push `:X.Y.Z`, `:X.Y`, `:latest`, then SSH to the VPS over the
  tailnet and `git pull --ff-only && docker compose pull`.
- Rollback: re-tag an older `:sha-xxxxxxx`.
- Secrets: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`, `TS_AUTHKEY`,
  `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`. Third-party actions are SHA-pinned.

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `NEEDS_AUTH` (exit 2) | no `creds.json` and no TTY → run once with a TTY to scan QR |
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
