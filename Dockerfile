# pi requires Node >= 22.19
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/
# better-sqlite3 ships a binding.gyp, and npm defaults to node-gyp for any
# package that has one without its own install script. This stage is thrown
# away, so it gets a real toolchain and every dependency's install script runs
# as its author intended.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN npm install
COPY server server
COPY web web
RUN npm run build

FROM node:22-slim
# The container executor launches sibling containers through the mounted socket.
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app

# git and openssh so pi can work with real repos; ca-certificates for HTTPS.
# curl and wget because install scripts and the /data/bin workflow assume them.
# Installed here rather than into a running container, where they look like they
# stuck — a restart keeps them — and then vanish on the next rebuild.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client ca-certificates curl wget \
    && rm -rf /var/lib/apt/lists/*

# uv, so the agent can run Python tooling — a large share of MCP servers are
# Python and are launched with uvx. Static musl binaries, no Python needed to
# install them; uv fetches a managed interpreter on first use, into HOME on the
# data volume. Pinned so a rebuild does not silently change the toolchain.
COPY --from=ghcr.io/astral-sh/uv:0.12.1 /uv /uvx /usr/local/bin/

RUN npm install -g @earendil-works/pi-coding-agent@latest

COPY package.json package-lock.json* ./
COPY server/package.json server/
# No toolchain here, and none needed: better-sqlite3 ships prebuilt binaries
# and resolves them at require time. Skipping install scripts keeps the runtime
# image slim instead of carrying a compiler for a binary that already exists.
RUN npm install --omit=dev -w server --ignore-scripts

COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist

# The builtin channel packages. Loaded from here at runtime; third-party ones
# are installed into CHANNELS_DIR on the data volume instead, so they survive
# an image rebuild.
COPY channels channels

# Skills the portal ships. Loaded from here for every session; anything the
# agent writes goes to the data volume instead.
COPY skills skills
COPY deploy/voice deploy/voice

# HOME lives on the data volume so pi packages and settings (~/.pi/agent)
# survive image rebuilds instead of being silently wiped.
# /data/bin is the escape hatch: anything dropped there is on PATH for pi and
# every tool it launches, and survives an image rebuild. Installing a CLI into
# the image filesystem instead looks like it worked — it survives a restart —
# and then vanishes on the next deploy, which rebuilds.
ENV PATH=/data/bin:$PATH
ENV NODE_ENV=production \
    PORT=4100 \
    DATA_DIR=/data \
    SESSION_DIR=/data/sessions \
    WORKSPACE_ROOT=/workspaces \
    CHANNELS_DIR=/data/channels \
    AGENT_HOME=/data/agent-home \
    HOME=/data/home
RUN mkdir -p /data/home /data/bin
EXPOSE 4100
VOLUME /data
CMD ["node", "server/dist/index.js"]
