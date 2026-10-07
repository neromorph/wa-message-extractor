// wa-readonly — project-local oxlint plugin.
//
// AST-accurate counterpart to the runtime Proxy deny-list in index.js.
// Flags real CallExpressions to WhatsApp-mutating socket methods.
//
// The Proxy's own denylist *strings* must not trip this rule: this plugin
// only inspects MemberExpression callees (obj.METHOD(...)), never
// string literals inside arrays.
import { defineRule } from "@oxlint/plugins";

const MUTATING_METHODS = new Set([
  "sendMessage",
  "sendReceipt",
  "sendReceipts",
  "readMessages",
  "chatModify",
  "sendPresenceUpdate",
  "presenceSubscribe",
  "updateProfileStatus",
  "updateProfileName",
  "updateProfilePicture",
  "removeProfilePicture",
  "fetchPrivacySettings",
  "updateBlockStatus",
  "updateLastSeenPrivacy",
  "updateOnlinePrivacy",
  "updateReadReceiptsPrivacy",
  "updateGroupsAddPrivacy",
  "updateDefaultDisappearingMode",
  "groupCreate",
  "groupLeave",
  "groupUpdateSubject",
  "groupUpdateDescription",
  "groupParticipantsUpdate",
  "groupSettingUpdate",
  "groupInviteCode",
  "groupRevokeInvite",
  "groupAcceptInvite",
  "groupGetInviteInfo",
  "newsletterCreate",
  "newsletterUpdate",
  "newsletterDelete",
  "newsletterReact",
  "newsletterFollow",
  "newsletterUnfollow",
  "newsletterMute",
  "newsletterUnmute",
  "logout",
  "requestPairingCode",
]);

export const noWhatsappMutationRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow calls to WhatsApp-mutating socket methods; this app is strictly read-only.",
    },
    messages: {
      mutation:
        "Call to `{{method}}` mutates WhatsApp state. This extractor is strictly read-only — remove this call.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression") {
          return;
        }
        if (callee.computed) {
          return;
        }
        const prop = callee.property;
        if (prop.type !== "Identifier") {
          return;
        }
        if (MUTATING_METHODS.has(prop.name)) {
          context.report({
            node,
            messageId: "mutation",
            data: { method: prop.name },
          });
        }
      },
    };
  },
});

const waReadonlyPlugin = {
  meta: { name: "wa-readonly" },
  rules: {
    "no-whatsapp-mutation": noWhatsappMutationRule,
  },
};

export default waReadonlyPlugin;
