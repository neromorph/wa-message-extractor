#!/usr/bin/env node
/**
 * wa-message-extractor — secure, read-only WhatsApp message extractor.
 *
 * Flow: authenticate -> fetch history within window -> format JSON -> stdout -> exit.
 *
 * READ-ONLY CONTRACT (enforced, not just promised):
 *  1. The raw Baileys socket never escapes `connectOnce()` — callers only get
 *     a narrow handle (`on`, `groupMetadata`, `close`, `me`).
 *  2. That handle is a Proxy that throws on any mutating method name.
 *  3. `tools/oxlint/wa-readonly` flags mutating call sites at lint time.
 *
 * This module never calls: sendMessage, sendReceipt(s), readMessages,
 * chatModify, logout, presence updates, group management, or profile edits.
 * It also never deletes credentials or unlinks the device.
 *
 * stdout carries ONLY the JSON payload. Logs, QR codes and progress go to
 * stderr so `node index.js --all | jq` and Hermes no-agent delivery work.
 */

import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  proto,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { Command } from "commander";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { MUTATING_METHODS } from "./tools/deny-list.js";

const DEFAULT_TOPIC = "general";
const SETTLE_MS = 3000;
const DEFAULT_WINDOW_MINUTES = 60;
const DEFAULT_WAIT_SECS = 30;
const DEFAULT_GLOBAL_TIMEOUT_SECS = 120;
const MAX_RECONNECTS = 3;

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_NEEDS_AUTH = 2;
const EXIT_PARTIAL_STRICT = 3;

const logger = pino(
  { level: process.env.LOG_LEVEL || "info" },
  process.stderr,
);

// ---------------------------------------------------------------------------
// Read-only socket wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap a Baileys socket so any access to a mutating method throws.
 * Only plain property reads are forwarded (no Reflect — see ADR-003).
 */
export function createReadOnlySocket(sock) {
  const denied = new Set(MUTATING_METHODS);
  return new Proxy(sock, {
    get(target, prop, _receiver) {
      if (denied.has(prop)) {
        throw new Error(
          `Read-only violation: socket.${String(prop)} is blocked. ` +
            "This extractor must never mutate WhatsApp state.",
        );
      }
      const value = target[prop];
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
    set(_target, prop, _value) {
      throw new Error(
        `Read-only violation: cannot set socket.${String(prop)}.`,
      );
    },
  });
}

// ---------------------------------------------------------------------------
// Message parsing (pure helpers — unit tested)
// ---------------------------------------------------------------------------

const WRAPPER_KEYS = new Set([
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "documentWithCaptionMessage",
  "editedMessage",
]);

function unwrapMessage(message) {
  let current = message;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current === null || current === undefined) {
      return undefined;
    }
    let descended = false;
    for (const key of WRAPPER_KEYS) {
      const wrapper = current[key];
      if (wrapper !== null && wrapper !== undefined && wrapper.message) {
        current = wrapper.message;
        descended = true;
        break;
      }
    }
    if (!descended) {
      return current;
    }
  }
  return current;
}

/**
 * Extract display text and a coarse type from a WAMessage.
 * Media is never downloaded — captions only, otherwise text is null.
 *
 * Each row: [message key, text source, message_type]. The source is a field
 * name, null (never has text), or a picker function. First match wins, so
 * row order is the precedence order.
 */
const MESSAGE_TEXT_FIELDS = [
  ["extendedTextMessage", "text", "text"],
  ["imageMessage", "caption", "image"],
  ["videoMessage", "caption", "video"],
  ["documentMessage", "caption", "document"],
  ["audioMessage", null, "audio"],
  ["stickerMessage", null, "sticker"],
  ["reactionMessage", "text", "reaction"],
  ["pollCreationMessage", "name", "poll"],
  ["pollCreationMessageV2", "name", "poll"],
  ["pollCreationMessageV3", "name", "poll"],
  [
    "buttonsResponseMessage",
    (part) => part.selectedDisplayText || part.selectedButtonId || null,
    "buttons_response",
  ],
  ["listResponseMessage", "title", "list_response"],
  ["templateButtonReplyMessage", "selectedId", "template_reply"],
  ["locationMessage", null, "location"],
  ["liveLocationMessage", null, "live_location"],
  ["contactMessage", null, "contact"],
];

export function extractMessageText(wam) {
  const message = unwrapMessage(wam.message);
  if (message === null || message === undefined) {
    return { text: null, message_type: "unknown" };
  }
  if (message.conversation) {
    return { text: message.conversation, message_type: "text" };
  }
  for (const [key, source, type] of MESSAGE_TEXT_FIELDS) {
    const part = message[key];
    if (!part) {
      continue;
    }
    if (typeof source === "function") {
      return { text: source(part), message_type: type };
    }
    return { text: source ? part[source] || null : null, message_type: type };
  }
  const keys = Object.keys(message);
  const firstKey = keys.length > 0 ? keys[0] : "unknown";
  return { text: null, message_type: firstKey };
}

export function messageTimestampMs(wam) {
  const raw = wam.messageTimestamp;
  const asNumber = Number(raw);
  if (Number.isNaN(asNumber) || asNumber <= 0) {
    return 0;
  }
  return asNumber * 1000;
}

/** Group messages carry participant; DMs carry the peer in remoteJid. */
export function senderJidOf(wam) {
  const key = wam.key || {};
  if (key.participant) {
    return key.participant;
  }
  return key.remoteJid || "unknown";
}

/**
 * Sender display name precedence:
 * pushName -> history contact name/notify -> group participant notify/name
 * -> JID local part.
 */
export function resolveSenderName(parts) {
  const bag = parts || {};
  if (bag.pushName) {
    return bag.pushName;
  }
  if (bag.contactName) {
    return bag.contactName;
  }
  if (bag.contactNotify) {
    return bag.contactNotify;
  }
  if (bag.participantNotify) {
    return bag.participantNotify;
  }
  if (bag.participantName) {
    return bag.participantName;
  }
  const jid = bag.fallbackJid || "unknown";
  const local = jid.split("@")[0];
  if (local) {
    return local;
  }
  return "unknown";
}

/** Keep messages at/after the cutoff. Unknown timestamps are dropped. */
export function filterByWindow(messages, cutoffMs) {
  return messages.filter((wam) => {
    const ts = messageTimestampMs(wam);
    return ts > 0 && ts >= cutoffMs;
  });
}

export function normalizeMessage(wam, context) {
  const ctx = context || {};
  const senderJid = senderJidOf(wam);
  const extracted = extractMessageText(wam);
  const contact = ctx.contacts ? ctx.contacts.get(senderJid) : undefined;
  const participant = ctx.participants ? ctx.participants.get(senderJid) : undefined;
  const name = resolveSenderName({
    pushName: wam.pushName,
    contactName: contact ? contact.name : undefined,
    contactNotify: contact ? contact.notify : undefined,
    participantNotify: participant ? participant.notify : undefined,
    participantName: participant ? participant.name : undefined,
    fallbackJid: senderJid,
  });
  return {
    sender_jid: senderJid,
    sender_name: name,
    from_me: Boolean(wam.key && wam.key.fromMe),
    timestamp: new Date(messageTimestampMs(wam)).toISOString(),
    text: extracted.text,
    message_type: extracted.message_type,
  };
}

// ---------------------------------------------------------------------------
// Result builders (pure — unit tested)
// ---------------------------------------------------------------------------

export function buildTargetResult(input) {
  const total = input.messages.length;
  const sync = input.historySync || {};
  const partial = sync.stopped_by === "cap";
  return {
    status: partial ? "PARTIAL" : "OK",
    meta: {
      target_alias: input.target.alias,
      destination_telegram_topic: input.topic || DEFAULT_TOPIC,
      time_window_minutes: input.windowMinutes,
      extracted_at: input.extractedAt,
      total_messages: total,
      history_sync: input.historySync,
    },
    messages: input.messages,
  };
}

export function buildEnvelope(inputs) {
  const results = inputs.results;
  let total = 0;
  let partials = 0;
  for (const result of results) {
    total += result.meta.total_messages;
    if (result.status === "PARTIAL") {
      partials += 1;
    }
  }
  let status = "OK";
  if (partials > 0) {
    status = "PARTIAL";
  }
  return {
    status,
    meta: {
      destination_telegram_topic: inputs.topic || DEFAULT_TOPIC,
      time_window_minutes: inputs.windowMinutes,
      extracted_at: inputs.extractedAt,
      target_count: results.length,
      total_messages: total,
      history_sync: inputs.historySync,
    },
    results,
  };
}

// ---------------------------------------------------------------------------
// Config loading (lazy — --jid works without targets.json)
// ---------------------------------------------------------------------------

export function loadTargetsFile(customPath) {
  const path = customPath || fileURLToPath(new URL("./targets.json", import.meta.url));
  let stat;
  try {
    stat = statSync(path);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(
        `targets.json not found at ${path}. ` +
          "Create it from the README sample or use --jid for a direct JID.",
      );
    }
    throw error;
  }
  if (stat.isDirectory()) {
    throw new Error(
      `targets.json at ${path} is a directory. ` +
        "Docker creates a directory when the host file is missing — " +
        "create ./targets.json on the host and re-run.",
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`targets.json at ${path} is not valid JSON.`);
  }
  const list = parsed.targets;
  if (!Array.isArray(list)) {
    throw new Error('targets.json must contain a "targets" array.');
  }
  return list;
}

// ---------------------------------------------------------------------------
// Output + process contract
// ---------------------------------------------------------------------------

let emitted = false;
let watchdog = null;

function clearWatchdog() {
  if (watchdog) {
    clearTimeout(watchdog);
    watchdog = null;
  }
}

export function armWatchdog(timeoutSecs, onFire) {
  clearWatchdog();
  watchdog = setTimeout(onFire, timeoutSecs * 1000);
}

function writeStdoutJson(payload, exitCode) {
  if (emitted) {
    return;
  }
  emitted = true;
  clearWatchdog();
  const pretty = Boolean(process.stdout.isTTY);
  const body = pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
  process.stdout.write(`${body}\n`, () => {
    process.exit(exitCode);
  });
}

const EXIT_FOR_STATUS = {
  OK: EXIT_OK,
  NEEDS_AUTH: EXIT_NEEDS_AUTH,
  ERROR: EXIT_ERROR,
};

function exitCodeForStatus(status, strict) {
  if (status === "PARTIAL") {
    return strict ? EXIT_PARTIAL_STRICT : EXIT_OK;
  }
  return EXIT_FOR_STATUS[status] ?? EXIT_ERROR;
}

function errorPayload(message, base) {
  const payload = { status: "ERROR", message };
  if (base) {
    payload.meta = {
      destination_telegram_topic: base.topic || DEFAULT_TOPIC,
      time_window_minutes: base.windowMinutes,
      extracted_at: new Date().toISOString(),
    };
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Baileys connection (the only place the raw socket exists)
// ---------------------------------------------------------------------------

function syncTypeName(value) {
  return proto.HistorySync.HistorySyncType[value] ?? String(value);
}

function disconnectCode(error) {
  if (error && error.output && typeof error.output.statusCode === "number") {
    return error.output.statusCode;
  }
  return undefined;
}

export function isRetryable(code) {
  return (
    code === DisconnectReason.restartRequired ||
    code === DisconnectReason.connectionLost ||
    code === DisconnectReason.connectionClosed ||
    code === DisconnectReason.timedOut
  );
}

function closeSocket(sock) {
  // sock.end exists in the pinned Baileys; failures mean already closing.
  try {
    const done = sock.end(undefined);
    if (done && typeof done.catch === "function") {
      done.catch(() => {});
    }
  } catch {
    // already closing — nothing to do
  }
}

export function failureCode(failure) {
  return failure && typeof failure.code === "number" ? failure.code : undefined;
}

const PAIRED_MARKER = ".paired-ok";
const POISONED_CODE = "POISONED";

let quarantineUsed = false;

export function isPaired(authDir) {
  try {
    return statSync(join(authDir, PAIRED_MARKER)).isFile();
  } catch {
    return false;
  }
}

export function markPaired(authDir) {
  writeFileSync(join(authDir, PAIRED_MARKER), `${new Date().toISOString()}\n`);
}

export function quarantineCreds(authDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = join(authDir, `creds.json.bak-${stamp}`);
  renameSync(join(authDir, "creds.json"), backup);
  return backup;
}

/**
 * Open one session. Normalizes the poisoned-creds deadlock: a 401 on
 * creds that never completed a login quarantines once per run, then
 * continues (fresh QR if interactive, POISONED error if not).
 * Returns { sock, safe }. Everything else passes through untouched.
 */
export async function openSession(input) {
  const { sock, safe } = await openSocket(input.authDir);
  try {
    await waitForOpen(sock, input.interactive);
  } catch (failure) {
    closeSocket(sock);
    const code = failureCode(failure);
    if (
      code === DisconnectReason.loggedOut &&
      !quarantineUsed &&
      !isPaired(input.authDir) &&
      existsSync(join(input.authDir, "creds.json"))
    ) {
      quarantineUsed = true;
      const backup = quarantineCreds(input.authDir);
      logger.warn({ backup }, "quarantined poisoned credentials");
      if (!input.interactive) {
        const poisoned = new Error(
          `Poisoned session quarantined to ${backup}. Re-pair interactively.`,
        );
        poisoned.code = POISONED_CODE;
        poisoned.backup = backup;
        throw poisoned;
      }
      return openSession(input);
    }
    throw failure;
  }
  if (!isPaired(input.authDir)) {
    markPaired(input.authDir);
  }
  return { sock, safe };
}

/**
 * Create one Baileys socket wrapped in the read-only Proxy.
 * The raw socket never leaves this module's connection functions.
 */
async function openSocket(authDir) {
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    browser: Browsers.ubuntu("Chrome"),
    markOnlineOnConnect: false,
    emitOwnEvents: false,
    syncFullHistory: false,
    getMessage: async () => undefined,
  });
  const safe = createReadOnlySocket(sock);
  sock.ev.on("creds.update", () => {
    saveCreds().catch((error) => {
      logger.fatal({ authDir, error: String(error) }, "failed to save credentials");
    });
  });
  return { sock, safe };
}

/**
 * Wait for the connection to open, showing the QR on stderr in
 * interactive mode. Rejects with { code, error } on early close.
 */
function waitForOpen(sock, interactive) {
  return new Promise((resolve, reject) => {
    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        if (interactive) {
          logger.info("Scan the QR code below with WhatsApp (Linked devices).");
          qrcode.generate(qr, { small: true }, (code) => {
            process.stderr.write(`${code}\n`);
          });
        } else {
          logger.warn("QR requested but stdout is not a TTY — cannot display it.");
        }
      }
      if (connection === "open") {
        resolve();
      }
      if (connection === "close") {
        const code = disconnectCode(lastDisconnect ? lastDisconnect.error : undefined);
        reject({ code, error: lastDisconnect ? lastDisconnect.error : undefined });
      }
    });
  });
}

/**
 * Open one connection, collect history + live messages for the target JIDs,
 * then resolve. Rejects with { fatal, message } on unrecoverable errors.
 */
async function connectOnce(input) {
  const { sock, safe } = await openSession(input);

  const targetJids = new Set(input.targets.map((target) => target.jid));
  const collected = [];
  const contacts = new Map();
  const syncTypes = new Set();
  let chunks = 0;
  let statusComplete = false;
  let explicitComplete = false;
  let notifyChunk = () => {};
  let notifyStatus = () => {};

  const isWanted = (wam) => {
    const remote = wam.key ? wam.key.remoteJid : undefined;
    return Boolean(remote && targetJids.has(remote));
  };

  sock.ev.on("messaging-history.set", ({ contacts: fresh, messages, syncType }) => {
    if (Array.isArray(fresh)) {
      for (const contact of fresh) {
        if (contact && contact.id) {
          contacts.set(contact.id, { name: contact.name, notify: contact.notify });
        }
      }
    }
    if (typeof syncType === "number") {
      syncTypes.add(syncTypeName(syncType));
    }
    if (Array.isArray(messages)) {
      chunks += 1;
      for (const wam of messages) {
        if (isWanted(wam)) {
          collected.push(wam);
        }
      }
      notifyChunk();
    }
  });

  sock.ev.on("messages.upsert", ({ messages }) => {
    if (Array.isArray(messages)) {
      for (const wam of messages) {
        if (isWanted(wam)) {
          collected.push(wam);
        }
      }
    }
  });

  sock.ev.on("messaging-history.status", ({ syncType, status, explicit }) => {
    if (status === "complete") {
      statusComplete = true;
      if (explicit) {
        explicitComplete = true;
      }
      if (typeof syncType === "number") {
        syncTypes.add(syncTypeName(syncType));
      }
      logger.info({ syncType: syncTypeName(syncType), explicit }, "history sync complete");
      notifyStatus();
    }
  });

  // connection.update "close" during the sync window must abort the wait
  let abortSync = null;
  const closeWatcher = (update) => {
    if (update.connection === "close" && abortSync) {
      const code = disconnectCode(
        update.lastDisconnect ? update.lastDisconnect.error : undefined,
      );
      abortSync({ code });
    }
  };
  sock.ev.on("connection.update", closeWatcher);

  const cutoffMs = Date.now() - input.windowMinutes * 60 * 1000;

  // Best-effort participant names for group targets (read query, not a mutation).
  const participants = new Map();
  await Promise.all(
    input.targets.map(async (target) => {
      if (!target.jid.endsWith("@g.us")) {
        return;
      }
      try {
        const meta = await Promise.race([
          safe.groupMetadata(target.jid),
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error("groupMetadata timeout")), 10000);
          }),
        ]);
        const list = meta && Array.isArray(meta.participants) ? meta.participants : [];
        for (const participant of list) {
          if (participant && participant.id && !participants.has(participant.id)) {
            participants.set(participant.id, {
              name: participant.name,
              notify: participant.notify,
            });
          }
        }
      } catch (error) {
        logger.warn({ jid: target.jid, error: String(error) }, "group metadata unavailable");
      }
    }),
  );

  const syncResult = await new Promise((resolve, reject) => {
    let done = false;
    const finish = (stoppedBy) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(capTimer);
      clearTimeout(quietTimer);
      resolve({ stoppedBy });
    };
    abortSync = (failure) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(capTimer);
      clearTimeout(quietTimer);
      reject(failure);
    };
    const capTimer = setTimeout(() => finish("cap"), input.waitSecs * 1000);
    let quietTimer = null;
    const armQuiet = () => {
      if (quietTimer) {
        clearTimeout(quietTimer);
      }
      quietTimer = setTimeout(() => {
        if (chunks > 0 || statusComplete) {
          finish(statusComplete ? "status" : "silence");
        }
      }, SETTLE_MS);
    };
    notifyChunk = armQuiet;
    notifyStatus = armQuiet;
    // Seed the quiet timer in case history already arrived before open.
    if (chunks > 0) {
      armQuiet();
    }
  });

  closeSocket(sock);

  return {
    collected,
    contacts,
    participants,
    cutoffMs,
    historySync: {
      chunks_received: chunks,
      messages_seen: collected.length,
      sync_types: Array.from(syncTypes).sort(),
      completed_explicitly: explicitComplete,
      stopped_by: syncResult.stoppedBy,
    },
  };
}

/**
 * Format group metadata into the --list-groups payload shape (pure).
 */
export function formatGroupList(all) {
  const table = all || {};
  return Object.values(table)
    .filter((meta) => meta && meta.id)
    .map((meta) => ({
      jid: meta.id,
      name: meta.subject || "",
      participants: Array.isArray(meta.participants) ? meta.participants.length : 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Connect, fetch all participating groups (read query), print, exit.
 */
async function listGroups(input) {
  const { sock, safe } = await openSession(input);
  const all = await safe.groupFetchAllParticipating();
  closeSocket(sock);
  return formatGroupList(all);
}

/**
 * Authenticate only: connect (QR on first run), save creds, close, exit.
 * No history sync, no queries. Retries the post-pairing restart (515).
 */
async function authOnly(input) {
  let attempt = 0;
  for (;;) {
    try {
      const { sock } = await openSession(input);
      closeSocket(sock);
      return;
    } catch (failure) {
      const code = failureCode(failure);
      if (!isRetryable(code) || attempt >= MAX_RECONNECTS) {
        throw failure;
      }
      const backoff = 2000 * 2 ** attempt;
      logger.warn({ code, attempt: attempt + 1, backoffMs: backoff }, "auth retrying");
      await new Promise((resolve) => {
        setTimeout(resolve, backoff);
      });
      attempt += 1;
    }
  }
}

const LOGGED_OUT_MESSAGE =
  "WhatsApp session logged out (401). Delete the auth directory contents and re-run interactively to scan a fresh QR code. Credentials were NOT deleted automatically.";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function buildProgram() {
  const program = new Command();
  program
    .name("wa-message-extractor")
    .description("Read-only WhatsApp message extractor (JSON to stdout).")
    .option("--target <alias>", "process a single target by alias from targets.json")
    .option("--jid <jid>", "process a single direct JID")
    .option("--all", "process all enabled targets from targets.json")
    .option("--list-groups", "list all participating groups as JSON and exit")
    .option("--auth", "authenticate only: scan QR, save creds, exit")
    .option("--window <minutes>", "time window in minutes", String(DEFAULT_WINDOW_MINUTES))
    .option("--wait <seconds>", "max seconds to wait for history sync", String(DEFAULT_WAIT_SECS))
    .option(
      "--timeout <seconds>",
      "global watchdog in seconds",
      String(DEFAULT_GLOBAL_TIMEOUT_SECS),
    )
    .option("--auth-dir <path>", "directory for Baileys auth tokens", "/app/auth_info")
    .option("--topic <name>", "Telegram topic for routing intent", DEFAULT_TOPIC)
    .option("--strict", "exit 3 when any result is PARTIAL", false);
  return program;
}

async function main(argv) {
  const program = buildProgram();
  program.parse(argv);
  const opts = program.opts();

  const windowMinutes = Number(opts.window);
  const waitSecs = Number(opts.wait);
  const timeoutSecs = Number(opts.timeout);
  const topic = opts.topic && opts.topic.trim() ? opts.topic.trim() : DEFAULT_TOPIC;
  const base = { windowMinutes, topic };
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    writeStdoutJson(errorPayload("--window must be a positive number of minutes."), EXIT_ERROR);
    return;
  }
  if (!Number.isFinite(waitSecs) || waitSecs <= 0) {
    writeStdoutJson(errorPayload("--wait must be a positive number of seconds."), EXIT_ERROR);
    return;
  }

  const selectors = [
    opts.target,
    opts.jid,
    opts.all ? "all" : undefined,
    opts.listGroups ? "list" : undefined,
    opts.auth ? "auth" : undefined,
  ].filter((value) => value !== undefined);
  if (selectors.length === 0) {
    program.help();
    return;
  }
  if (selectors.length > 1) {
    writeStdoutJson(
      errorPayload("Pass exactly one of --target, --jid, --all, --list-groups, or --auth.", base),
      EXIT_ERROR,
    );
    return;
  }

  armWatchdog(timeoutSecs > 0 ? timeoutSecs : DEFAULT_GLOBAL_TIMEOUT_SECS, () => {
    writeStdoutJson(
      errorPayload("Global timeout reached before extraction completed.", base),
      EXIT_ERROR,
    );
  });

  const onSignal = (signal) => {
    logger.warn({ signal }, "interrupted");
    writeStdoutJson(errorPayload(`Interrupted by ${signal}.`, base), EXIT_ERROR);
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));

  // Resolve targets (lazy: --jid never touches targets.json).
  let targets;
  try {
    if (opts.jid) {
      targets = [{ alias: opts.jid, name: "Direct JID", jid: opts.jid, enabled: true }];
    } else {
      const list = loadTargetsFile();
      if (opts.target) {
        const found = list.find((entry) => entry.alias === opts.target);
        if (!found) {
          writeStdoutJson(
            errorPayload(`Target alias "${opts.target}" not found in targets.json.`, base),
            EXIT_ERROR,
          );
          return;
        }
        if (found.enabled === false) {
          writeStdoutJson(
            errorPayload(`Target alias "${opts.target}" is disabled in targets.json.`, base),
            EXIT_ERROR,
          );
          return;
        }
        targets = [found];
      } else {
        targets = list.filter((entry) => entry.enabled !== false);
        if (targets.length === 0) {
          writeStdoutJson(
            errorPayload("No enabled targets in targets.json.", base),
            EXIT_ERROR,
          );
          return;
        }
      }
    }
  } catch (error) {
    writeStdoutJson(errorPayload(String(error.message || error), base), EXIT_ERROR);
    return;
  }

  for (const target of targets) {
    if (!target.jid || (!target.jid.endsWith("@g.us") && !target.jid.endsWith("@s.whatsapp.net") && !target.jid.endsWith("@lid"))) {
      writeStdoutJson(
        errorPayload(`Target "${target.alias}" has an invalid JID: ${target.jid}`, base),
        EXIT_ERROR,
      );
      return;
    }
  }

  // Auth gate: no creds + non-interactive -> NEEDS_AUTH without opening a socket.
  const interactive = Boolean(process.stdin.isTTY);
  const credsPath = join(opts.authDir, "creds.json");
  if (!existsSync(credsPath) && !interactive) {
    writeStdoutJson(
      { status: "NEEDS_AUTH", message: "Run interactively to scan QR code." },
      EXIT_NEEDS_AUTH,
    );
    return;
  }

  // Auth-only mode: no targets.json, no history, no queries.
  if (opts.auth) {
    try {
      await authOnly({ authDir: opts.authDir, interactive });
    } catch (failure) {
      if (failure && failure.code === POISONED_CODE) {
        writeStdoutJson(errorPayload(String(failure.message), base), EXIT_ERROR);
        return;
      }
      const code = failureCode(failure);
      if (code === DisconnectReason.loggedOut) {
        writeStdoutJson(errorPayload(LOGGED_OUT_MESSAGE, base), EXIT_ERROR);
      } else {
        const detail = failure && failure.error ? String(failure.error) : `disconnect code ${code}`;
        writeStdoutJson(errorPayload(`Authentication failed: ${detail}`, base), EXIT_ERROR);
      }
      return;
    }
    logger.info("authenticated, credentials saved");
    writeStdoutJson(
      {
        status: "OK",
        meta: {
          destination_telegram_topic: topic,
          authenticated_at: new Date().toISOString(),
        },
        message: "WhatsApp session authenticated and saved.",
      },
      EXIT_OK,
    );
    return;
  }

  // Group discovery needs no targets.json and no history wait.
  if (opts.listGroups) {
    let groups;
    try {
      groups = await listGroups({ authDir: opts.authDir, interactive });
    } catch (failure) {
      if (failure && failure.code === POISONED_CODE) {
        writeStdoutJson(errorPayload(String(failure.message), base), EXIT_ERROR);
        return;
      }
      const code = failureCode(failure);
      if (code === DisconnectReason.loggedOut) {
        writeStdoutJson(errorPayload(LOGGED_OUT_MESSAGE, base), EXIT_ERROR);
      } else {
        const detail = failure && failure.error ? String(failure.error) : `disconnect code ${code}`;
        writeStdoutJson(errorPayload(`Group listing failed: ${detail}`, base), EXIT_ERROR);
      }
      return;
    }
    const extractedAt = new Date().toISOString();
    logger.info({ total: groups.length }, "group listing complete");
    writeStdoutJson(
      {
        status: "OK",
        meta: {
          destination_telegram_topic: topic,
          extracted_at: extractedAt,
          total_groups: groups.length,
        },
        groups,
      },
      EXIT_OK,
    );
    return;
  }

  let attempt = 0;
  let collected = null;
  while (attempt <= MAX_RECONNECTS) {
    try {
      collected = await connectOnce({
        authDir: opts.authDir,
        targets,
        windowMinutes,
        waitSecs,
        interactive,
      });
      break;
    } catch (failure) {
      if (failure && failure.code === POISONED_CODE) {
        writeStdoutJson(errorPayload(String(failure.message), base), EXIT_ERROR);
        return;
      }
      const code = failureCode(failure);
      if (code === DisconnectReason.loggedOut) {
        writeStdoutJson(
          errorPayload(
            LOGGED_OUT_MESSAGE,
            base,
          ),
          EXIT_ERROR,
        );
        return;
      }
      if (isRetryable(code) && attempt < MAX_RECONNECTS) {
        const backoff = 2000 * 2 ** attempt;
        logger.warn({ code, attempt: attempt + 1, backoffMs: backoff }, "connection dropped, retrying");
        await new Promise((resolve) => {
          setTimeout(resolve, backoff);
        });
        attempt += 1;
        continue;
      }
      const detail = failure && failure.error ? String(failure.error) : `disconnect code ${code}`;
      writeStdoutJson(
        errorPayload(`WhatsApp connection failed: ${detail}`, base),
        EXIT_ERROR,
      );
      return;
    }
  }
  if (!collected) {
    writeStdoutJson(
      errorPayload("WhatsApp connection failed after retries.", base),
      EXIT_ERROR,
    );
    return;
  }

  const extractedAt = new Date().toISOString();
  const results = targets.map((target) => {
    const inWindow = filterByWindow(
      collected.collected.filter((wam) => wam.key && wam.key.remoteJid === target.jid),
      collected.cutoffMs,
    );
    const context = { contacts: collected.contacts, participants: collected.participants };
    const messages = inWindow
      .map((wam) => ({ ts: messageTimestampMs(wam), item: normalizeMessage(wam, context) }))
      .sort((a, b) => a.ts - b.ts)
      .map((entry) => entry.item);
    return buildTargetResult({
      target,
      messages,
      windowMinutes,
      extractedAt,
      topic,
      historySync: collected.historySync,
    });
  });

  if (opts.all) {
    const envelope = buildEnvelope({
      results,
      windowMinutes,
      extractedAt,
      topic,
      historySync: collected.historySync,
    });
    logger.info(
      {
        targets: targets.map((target) => target.alias).join(", "),
        total: envelope.meta.total_messages,
      },
      "extraction complete",
    );
    writeStdoutJson(envelope, exitCodeForStatus(envelope.status, opts.strict));
    return;
  }

  const single = results[0];
  logger.info(
    { target: single.meta.target_alias, total: single.meta.total_messages },
    "extraction complete",
  );
  writeStdoutJson(single, exitCodeForStatus(single.status, opts.strict));
}

const thisFile = fileURLToPath(import.meta.url);
const invokedAsScript = Boolean(
  process.argv[1] &&
    (process.argv[1] === thisFile || process.argv[1].endsWith("/index.js")),
);

if (invokedAsScript) {
  main(process.argv).catch((error) => {
    writeStdoutJson(
      errorPayload(`Unexpected failure: ${error && error.stack ? error.stack : String(error)}`),
      EXIT_ERROR,
    );
  });
}
