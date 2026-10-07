# Vendored from the `install-anti-slop` skill
# (source: ~/.agents/skills/install-anti-slop/assets/anti-slop).
# Installed 2026-10-07 via `node <skill>/scripts/install.mjs` (default target).
#
# - Loaded ONLY by oxlint (`jsPlugins` in .oxlintrc.jsonc). Never imported by
#   application code, tsc, or node at runtime.
# - 15 generic rules enabled at "error" in .oxlintrc.jsonc. In plain `.js`
#   files most are inert (they walk TSType nodes); `no-runtime-typeof` is
#   additionally scoped off for `**/*.js` — see ADR-003 in the project vault.
# - Do not hand-edit. To upgrade, re-run the skill installer with --force
#   after reviewing the diff, then re-run `npm run verify`.
