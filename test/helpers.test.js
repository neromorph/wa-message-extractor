import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DisconnectReason } from "@whiskeysockets/baileys";

import {
  buildEnvelope,
  buildTargetResult,
  createReadOnlySocket,
  extractMessageText,
  filterByWindow,
  formatGroupList,
  isPaired,
  isRetryable,
  loadTargetsFile,
  markPaired,
  messageTimestampMs,
  normalizeMessage,
  quarantineCreds,
  resolveSenderName,
  senderJidOf,
} from "../index.js";
import { MUTATING_METHODS } from "../tools/deny-list.js";

const nowMs = Date.now();
const minutesAgo = (minutes) => Math.floor((nowMs - minutes * 60 * 1000) / 1000);

function fakeTextMessage({ remoteJid, participant, fromMe, minutesOld, text, pushName }) {
  return {
    key: { remoteJid, participant, fromMe: Boolean(fromMe), id: `id-${minutesOld}` },
    messageTimestamp: minutesAgo(minutesOld),
    pushName,
    message: { conversation: text },
  };
}

describe("filterByWindow", () => {
  it("keeps messages at/after the cutoff and drops older ones", () => {
    const cutoff = nowMs - 60 * 60 * 1000;
    const fresh = fakeTextMessage({
      remoteJid: "a@g.us",
      minutesOld: 10,
      text: "fresh",
    });
    const stale = fakeTextMessage({
      remoteJid: "a@g.us",
      minutesOld: 120,
      text: "stale",
    });
    const result = filterByWindow([fresh, stale], cutoff);
    assert.equal(result.length, 1);
    assert.equal(result[0].message.conversation, "fresh");
  });

  it("drops messages with unknown timestamps", () => {
    const broken = {
      key: { remoteJid: "a@g.us", id: "x" },
      messageTimestamp: undefined,
      message: { conversation: "nope" },
    };
    assert.equal(filterByWindow([broken], nowMs - 1000).length, 0);
  });
});

describe("messageTimestampMs", () => {
  it("converts seconds to milliseconds", () => {
    assert.equal(messageTimestampMs({ messageTimestamp: 1000 }), 1000 * 1000);
  });

  it("returns 0 for missing timestamps", () => {
    assert.equal(messageTimestampMs({}), 0);
  });
});

describe("senderJidOf", () => {
  it("prefers participant for group messages", () => {
    const wam = fakeTextMessage({
      remoteJid: "group@g.us",
      participant: "6281@s.whatsapp.net",
      minutesOld: 1,
      text: "hi",
    });
    assert.equal(senderJidOf(wam), "6281@s.whatsapp.net");
  });

  it("falls back to remoteJid for DMs", () => {
    const wam = fakeTextMessage({
      remoteJid: "6281@s.whatsapp.net",
      minutesOld: 1,
      text: "hi",
    });
    assert.equal(senderJidOf(wam), "6281@s.whatsapp.net");
  });
});

describe("resolveSenderName", () => {
  it("follows the pushName -> contact -> participant -> JID chain", () => {
    assert.equal(resolveSenderName({ pushName: "Push", fallbackJid: "a@s.whatsapp.net" }), "Push");
    assert.equal(
      resolveSenderName({ contactName: "Saved", fallbackJid: "a@s.whatsapp.net" }),
      "Saved",
    );
    assert.equal(
      resolveSenderName({ contactNotify: "Notify", fallbackJid: "a@s.whatsapp.net" }),
      "Notify",
    );
    assert.equal(
      resolveSenderName({ participantNotify: "Member", fallbackJid: "a@s.whatsapp.net" }),
      "Member",
    );
    assert.equal(resolveSenderName({ fallbackJid: "62812@s.whatsapp.net" }), "62812");
    assert.equal(resolveSenderName({}), "unknown");
  });
});

describe("extractMessageText", () => {
  it("extracts conversation and extended text", () => {
    assert.deepEqual(extractMessageText({ message: { conversation: "hello" } }), {
      text: "hello",
      message_type: "text",
    });
    assert.deepEqual(
      extractMessageText({ message: { extendedTextMessage: { text: "long" } } }),
      { text: "long", message_type: "text" },
    );
  });

  it("uses captions for media and never invents text", () => {
    assert.deepEqual(extractMessageText({ message: { imageMessage: { caption: "cap" } } }), {
      text: "cap",
      message_type: "image",
    });
    assert.deepEqual(extractMessageText({ message: { audioMessage: {} } }), {
      text: null,
      message_type: "audio",
    });
  });

  it("unwraps ephemeral messages", () => {
    const wrapped = {
      message: { ephemeralMessage: { message: { conversation: "secret" } } },
    };
    assert.deepEqual(extractMessageText(wrapped), { text: "secret", message_type: "text" });
  });

  it("falls back to the message key for unknown types", () => {
    assert.deepEqual(extractMessageText({ message: { futureType: {} } }), {
      text: null,
      message_type: "futureType",
    });
    assert.deepEqual(extractMessageText({}), { text: null, message_type: "unknown" });
  });
});

describe("normalizeMessage", () => {
  it("builds the spec message shape", () => {
    const wam = fakeTextMessage({
      remoteJid: "group@g.us",
      participant: "6281@s.whatsapp.net",
      minutesOld: 5,
      text: "done",
      pushName: "Ops",
    });
    const item = normalizeMessage(wam, { contacts: new Map(), participants: new Map() });
    assert.equal(item.sender_jid, "6281@s.whatsapp.net");
    assert.equal(item.sender_name, "Ops");
    assert.equal(item.from_me, false);
    assert.equal(item.text, "done");
    assert.ok(!Number.isNaN(Date.parse(item.timestamp)));
  });

  it("resolves names from group participants when pushName is absent", () => {
    const wam = fakeTextMessage({
      remoteJid: "group@g.us",
      participant: "6281@s.whatsapp.net",
      minutesOld: 5,
      text: "done",
    });
    const participants = new Map([["6281@s.whatsapp.net", { notify: "OnCall" }]]);
    const item = normalizeMessage(wam, { contacts: new Map(), participants });
    assert.equal(item.sender_name, "OnCall");
  });
});

describe("createReadOnlySocket", () => {
  it("throws on every denied method", () => {
    const fake = { groupMetadata: async () => ({}), ev: { on: () => {} } };
    const safe = createReadOnlySocket(fake);
    for (const method of MUTATING_METHODS) {
      assert.throws(() => safe[method], /Read-only violation/);
    }
  });

  it("still allows read methods", async () => {
    const fake = { groupMetadata: async () => ({ ok: true }), ev: { on: () => {} } };
    const safe = createReadOnlySocket(fake);
    assert.deepEqual(await safe.groupMetadata("x@g.us"), { ok: true });
  });

  it("blocks property writes", () => {
    const safe = createReadOnlySocket({ ev: {} });
    assert.throws(() => {
      safe.ev = {};
    }, /Read-only violation/);
  });
});

describe("buildTargetResult", () => {
  const historySync = {
    chunks_received: 2,
    messages_seen: 1,
    sync_types: ["RECENT"],
    completed_explicitly: true,
    stopped_by: "status",
  };

  it("returns OK with the spec meta fields", () => {
    const result = buildTargetResult({
      target: { alias: "devops-team" },
      messages: [],
      windowMinutes: 60,
      extractedAt: "2026-10-07T12:30:00.000Z",
      historySync,
    });
    assert.equal(result.status, "OK");
    assert.equal(result.meta.target_alias, "devops-team");
    assert.equal(result.meta.destination_telegram_topic, "general");
    assert.equal(result.meta.time_window_minutes, 60);
    assert.equal(result.meta.total_messages, 0);
  });

  it("honours a custom topic", () => {
    const result = buildTargetResult({
      target: { alias: "devops-team" },
      messages: [],
      windowMinutes: 60,
      extractedAt: "2026-10-07T12:30:00.000Z",
      topic: "ops-alerts",
      historySync,
    });
    assert.equal(result.meta.destination_telegram_topic, "ops-alerts");
  });

  it("marks PARTIAL when the hard cap stopped the sync", () => {
    const result = buildTargetResult({
      target: { alias: "devops-team" },
      messages: [],
      windowMinutes: 60,
      extractedAt: "2026-10-07T12:30:00.000Z",
      historySync: { ...historySync, stopped_by: "cap" },
    });
    assert.equal(result.status, "PARTIAL");
  });
});

describe("buildEnvelope", () => {
  it("aggregates totals and degrades to PARTIAL", () => {
    const ok = buildTargetResult({
      target: { alias: "a" },
      messages: [{ text: "x" }],
      windowMinutes: 60,
      extractedAt: "2026-10-07T12:30:00.000Z",
      historySync: {
        chunks_received: 1,
        messages_seen: 1,
        sync_types: [],
        completed_explicitly: false,
        stopped_by: "silence",
      },
    });
    const partial = buildTargetResult({
      target: { alias: "b" },
      messages: [],
      windowMinutes: 60,
      extractedAt: "2026-10-07T12:30:00.000Z",
      historySync: {
        chunks_received: 0,
        messages_seen: 0,
        sync_types: [],
        completed_explicitly: false,
        stopped_by: "cap",
      },
    });
    const envelope = buildEnvelope({
      results: [ok, partial],
      windowMinutes: 60,
      extractedAt: "2026-10-07T12:30:00.000Z",
      topic: "general",
      historySync: ok.meta.history_sync,
    });
    assert.equal(envelope.status, "PARTIAL");
    assert.equal(envelope.meta.destination_telegram_topic, "general");
    assert.equal(envelope.meta.target_count, 2);
    assert.equal(envelope.meta.total_messages, 1);
    assert.equal(envelope.results.length, 2);
  });
});

describe("isRetryable", () => {
  it("retries transient closes but not logout", () => {
    assert.equal(isRetryable(DisconnectReason.restartRequired), true);
    assert.equal(isRetryable(DisconnectReason.connectionLost), true);
    assert.equal(isRetryable(DisconnectReason.loggedOut), false);
    assert.equal(isRetryable(undefined), false);
  });
});

describe("session marker", () => {
  it("round-trips mark/isPaired in a tmp dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-session-"));
    assert.equal(isPaired(dir), false);
    markPaired(dir);
    assert.equal(isPaired(dir), true);
  });
});

describe("quarantineCreds", () => {
  it("renames creds.json to a timestamped backup and returns the path", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-session-"));
    writeFileSync(join(dir, "creds.json"), "{}");
    const backup = quarantineCreds(dir);
    assert.match(backup, /creds\.json\.bak-/);
    assert.equal(existsSync(join(dir, "creds.json")), false);
    assert.equal(existsSync(backup), true);
  });
});

describe("formatGroupList", () => {
  it("maps metadata to JID list sorted by name", () => {
    const groups = formatGroupList({
      "222@g.us": { id: "222@g.us", subject: "Zulu", participants: [{}, {}] },
      "111@g.us": { id: "111@g.us", subject: "Alpha" },
      broken: null,
    });
    assert.deepEqual(groups, [
      { jid: "111@g.us", name: "Alpha", participants: 0 },
      { jid: "222@g.us", name: "Zulu", participants: 2 },
    ]);
  });

  it("tolerates missing input", () => {
    assert.deepEqual(formatGroupList(undefined), []);
  });
});

describe("loadTargetsFile", () => {
  it("names the docker-created-directory problem", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-targets-"));
    const fakeFile = join(dir, "targets.json");
    mkdirSync(fakeFile);
    assert.throws(() => loadTargetsFile(fakeFile), /is a directory/);
  });

  it("rejects invalid JSON and wrong shapes", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-targets-"));
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{nope");
    assert.throws(() => loadTargetsFile(bad), /not valid JSON/);
    const wrong = join(dir, "wrong.json");
    writeFileSync(wrong, JSON.stringify({ targets: "nope" }));
    assert.throws(() => loadTargetsFile(wrong), /"targets" array/);
  });

  it("reports a missing file with a --jid hint", () => {
    assert.throws(
      () => loadTargetsFile(join(tmpdir(), "wa-missing-targets.json")),
      /--jid/,
    );
  });
});
