# pi requires Node >= 22.19
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
# better-sqlite3 ships a binding.gyp, and npm defaults to node-gyp for any
# package that has one without its own install script. This stage is thrown
# away, so it gets a real toolchain and every dependency's install script runs
# as its author intended.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
# npm ci takes exactly what package-lock.json says, and stops when it and a
# package.json disagree, where npm install would quietly resolve the difference.
RUN npm ci
COPY server server
COPY web web
# The web build copies it next to the voice files it covers (web/scripts/copy-vad-assets.mjs).
COPY THIRD_PARTY_NOTICES.md ./
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
      sudo ripgrep fd-find \
    && rm -rf /var/lib/apt/lists/*

# The sandbox (Settings → Sandbox, off until switched on): each agent's commands
# and file tools run as a user of its own, which the portal makes as needed,
# trusted commands as pi-tools through sudo, and pi-sandbox owns what the agents
# share. Fixed ids, so what they own on the data volume still belongs to them
# after a rebuild. sudo, rg and fd are for the same: trusted commands, and pi's
# grep and find searching as the agent.
RUN groupadd --gid 10010 pi-sandbox \
    && useradd --uid 10002 --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin pi-tools

# uv, so the agent can run Python tooling — a large share of MCP servers are
# Python and are launched with uvx. Static musl binaries, no Python needed to
# install them; uv fetches a managed interpreter on first use, into HOME on the
# data volume. Pinned so a rebuild does not silently change the toolchain.
COPY --from=ghcr.io/astral-sh/uv:0.12.1 /uv /uvx /usr/local/bin/

COPY package.json package-lock.json ./
COPY server/package.json server/
# No toolchain here, and none needed: better-sqlite3 ships prebuilt binaries
# and resolves them at require time. Skipping install scripts keeps the runtime
# image slim instead of carrying a compiler for a binary that already exists.
# The cache goes in the same layer, or its tarballs stay in the image.
RUN npm ci --omit=dev -w server --ignore-scripts \
    && npm cache clean --force

# The pi on PATH is the one the portal's sessions run, from the lock, so that
# `pi install` and the chats are one version and a rebuild cannot bring in a
# release nobody has looked at.
RUN ln -s /app/node_modules/@earendil-works/pi-coding-agent/dist/cli.js /usr/local/bin/pi \
    && chmod +x /app/node_modules/@earendil-works/pi-coding-agent/dist/cli.js

COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist

# The builtin channel packages. Loaded from here at runtime; third-party ones
# are installed into CHANNELS_DIR on the data volume instead, so they survive
# an image rebuild.
COPY channels channels

# Skills the portal ships. Loaded from here for every session; anything the
# agent writes goes to the data volume instead.
COPY skills skills
# The opt-in pi extensions the portal ships (the subagent tool). Nothing loads
# them until a feature is switched on in Settings → Add-ons, which installs one
# as a local pi package pointing here.
COPY extensions extensions
COPY deploy/voice deploy/voice

# HOME lives on the data volume so pi packages and settings (~/.pi/agent)
# survive image rebuilds instead of being silently wiped.
# /data/bin is the escape hatch: anything dropped there is on PATH for pi and
# every tool it launches, and survives an image rebuild. Installing a CLI into
# the image filesystem instead looks like it worked — it survives a restart —
# and then vanishes on the next deploy, which rebuilds. It comes last, so a
# file there adds a tool and never stands in for node, git, docker or pi.
ENV PATH=$PATH:/data/bin
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
CMD ["/usr/local/bin/node", "server/dist/index.js"]
