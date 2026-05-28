# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS build

WORKDIR /app

# Native build deps for better-sqlite3 when no prebuilt is available for the
# current Node + glibc combination. Discarded in the runtime stage.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY . .
RUN npm run build && npm prune --omit=dev


FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules                       ./node_modules
COPY --from=build /app/dist                               ./dist

# Ship the policy example at /app so it survives a /policy volume mount.
# Bootstrap by copying it to /policy/policy.yaml on first run.
COPY --from=build /app/policy/policy.yaml.example         ./policy.yaml.example

RUN mkdir -p /data /policy \
  && chown -R node:node /data /policy

ENV MS365_MCP_SESSION_DB_PATH=/data/sessions.db
ENV MS365_MCP_POLICY_PATH=/policy/policy.yaml

USER node
EXPOSE 3000

# Seed /policy/policy.yaml from the shipped example on first start. Uses
# exec so SIGHUP (policy reload) propagates to the node process as PID 1.
CMD ["sh", "-c", "[ -f /policy/policy.yaml ] || cp /app/policy.yaml.example /policy/policy.yaml; exec node dist/index.js --http 0.0.0.0:3000"]
