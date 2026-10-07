# Stage 1 — builder (glibc, matches distroless debian13 runtime)
FROM node:24-trixie-slim AS builder

WORKDIR /app

# Layer caching: manifests only first
COPY package.json package-lock.json ./

# WASM-only deps: Baileys v7 lazy-loads sharp/jimp/audio-decode/link-preview-js
# via `import().catch()`, so peer + optional can be omitted (no libvips in image).
# --ignore-scripts: skips our own `prepare` (husky, a devDep absent here) and
# any dependency install scripts — nothing in this tree needs them.
RUN npm ci --omit=dev --omit=peer --omit=optional --ignore-scripts

# Remaining application files
COPY index.js ./
COPY targets.json ./
COPY tools/deny-list.js ./tools/deny-list.js

# Pre-seed auth dir owned by nonroot (UID 65532) so the named volume
# inherits correct ownership on first mount via Docker copy-up.
RUN mkdir -p /app/auth_info && chown 65532:65532 /app/auth_info

# Stage 2 — production runtime (rootless, distroless)
FROM gcr.io/distroless/nodejs24-debian13:nonroot

WORKDIR /app

COPY --from=builder --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=builder --chown=65532:65532 /app/index.js ./index.js
COPY --from=builder --chown=65532:65532 /app/targets.json ./targets.json
COPY --from=builder --chown=65532:65532 /app/tools/deny-list.js ./tools/deny-list.js
COPY --from=builder --chown=65532:65532 /app/auth_info ./auth_info

USER nonroot:nonroot

ENTRYPOINT ["/nodejs/bin/node", "index.js"]
