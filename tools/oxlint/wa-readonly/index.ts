// wa-readonly — project-local oxlint plugin.
//
// AST-accurate counterpart to the runtime Proxy deny-list in index.js.
// Flags real CallExpressions to WhatsApp-mutating socket methods.
//
// The Proxy's own denylist *strings* must not trip this rule: this plugin
// only inspects MemberExpression callees (obj.METHOD(...)), never
// string literals inside arrays.
import { defineRule } from "@oxlint/plugins";

import { MUTATING_METHODS } from "../../deny-list.js";

const MUTATING_SET = new Set(MUTATING_METHODS);

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
        if (MUTATING_SET.has(prop.name)) {
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
