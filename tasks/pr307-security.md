# PR #307 security audit — pithagoras-office (`extensions/office/`)

**Branch:** `office/280-pithagoras-office` @ fee666ce (base main)
**Scope:** full security pass over the slice `src/{jwt,tickets,callback,server,ping,container,tools,store,ooxml,live,host,settings}.ts`, `src/web/{api.ts,library.tsx,office-editor.tsx,state.ts}`, `src/client.tsx`, plus the platform seams they rely on (core login gate, `folders.allowed`, pithagoras-docker `sharedNetwork`).

## Scope

- JWT HS256 config signing / callback verification (`jwt.ts`)
- HMAC document tickets + loopback ticketed GET (`tickets.ts`, `server.ts` loopback listener)
- DS callback auth, envelope binding, persist path (`callback.ts`)
- Container lifecycle, DS env secrets, shared-network exposure (`container.ts`)
- Authorization: agent tool scoping vs human routes (`tools.ts`, `server.ts` route table)
- Path traversal / zip-slip (`store.ts`, `ooxml.ts`), XSS in the web client, SSRF, secrets/PII in logs, timing/oracles

## Method

Read every file in the slice in full; read the platform seams (`core/server/src/auth.ts` cookie flags, `core/server/src/agent-folders.ts` + `packages/extension-api/server.d.ts` for `folders.allowed`, `extensions/docker/src/docker.ts` `sharedNetwork()`) to confirm the trust boundaries each assumption rests on. Cross-checked claims (e.g. "same secret for callbacks/tickets/configs", "single shared login") against code rather than plan text. No test runs; no files modified.

---

## Findings

### 🔴 [blocking]

None found. The core crypto/auth design is sound — see "What's good". Everything below is 🟡 or lower.

### 🟡 [important]

**S1. In host mode the Document Server's stock nginx listens on ALL interfaces of the real host (not just 127.0.0.1), exposing an unauthenticated community-image web server to LAN/Tailscale.**
- `extensions/office/src/container.ts:210-211` sets `HostConfig.NetworkMode = "host"` when the portal runs directly on a Linux machine; the module header (`container.ts:22-30`) acknowledges "the stock nginx listens on :80 of the whole shared netns". In host mode that is the **host's** netns, and OnlyOffice's stock `listen 80` binds `0.0.0.0:80`.
- **Why it matters:** anything with network reach to the portal machine (LAN, Tailscale — per this deployment both PVE nodes masquerade into Tailnet) can drive the DS web surface: static assets, editor bootstrap, version endpoints — gated by the image's JWT env only for the signed config/callback flows. The PR defers the *container-mode* browser-reach decision to M0, but host-mode 0.0.0.0 exposure is not documented as an accepted choice. This also conflicts with any other service on :80.
- **Fix:** before merge, verify what the pinned `onlyoffice/documentserver:10.0` nginx actually binds and which endpoints are JWT-gated; then either (a) ship a custom nginx conf (named volume at `/etc/nginx/conf.d/ds.conf`) binding `127.0.0.1`, (b) route DS traffic through the session-gated portal, or (c) explicitly document the 0.0.0.0:80 exposure + required firewall rule in the README's deferred section and warn on first start when :80 is not loopback-only.

**S2. Presence is set at editor-config mint time and cleared unconditionally on DS terminal close — with one shared seat id, a failed open can lock a document to agents forever, or a second tab's close can unlock while a first is still editing.**
- `server.ts:271` (`live.setUser(doc.docId, EDITOR_USER, true)` in `buildEditorConfig`) and `callback.ts` status 2/4 handlers (`clearDoc(docId)` in the persist path and `case 4`). All human sessions share `EDITOR_USER = { id: "portal-user", name: "Portal" }` (`server.ts:57`).
- **Why it matters (two directions):**
  - *Stuck lock:* if the config is minted but api.js never loads (S1-style network failure, user closes tab before DS connects), no status-1/2/4 callback ever arrives; `live` state has no TTL (`live.ts` — plain in-memory maps), so the doc shows "editing now" forever and every `office_edit` is refused (`server.ts makeForcesaveHook()` returns false whenever `usersOf(docId)` is non-empty). A human can DoS agent editing of one document by merely opening it once.
  - *Early unlock:* with two browser tabs sharing the seat id, a terminal close callback for one tab wipes presence for both; the forcesave hook then resolves true and an agent edit proceeds over the other tab's unsaved buffer — defeating the explicit "never clobber an unsaved buffer" fail-closed design. (Confidence: medium — depends on DS multi-session callback semantics with a duplicated user id, which is not pinned down in code or tests.)
- **Fix:** set presence lazily from the first *DS-confirmed* status-1 (not at mint); add a join-TTL/heartbeat to `live.ts`; and on status 2/4 clear only when the callback's own `users` snapshot (when present) says nobody remains, or track an open-mint counter per doc. At minimum, document the single-seat limitation.

**S3. One shared secret covers all three token types and lives where any local process of the portal user can read it; no rotation path.**
- `server.ts:ensureJwtSecret` (0600 file in dataDir) → same value in `container.ts:96` (`JWT_SECRET` env) → used by `jwt.ts`, `tickets.ts` and every minted config.
- **Why it matters:** one leak = forge DS callbacks (overwrite any document, bypassing the revision gate, because a forger can read current mtime), mint tickets (read any document for 10 min), or sign editor configs. The blast radius is bounded by "reads as the portal OS user / has docker access" — but that includes *any other extension or tool running in the same portal process/host user*, and there is no rotation mechanism (shortening the file regenerates the secret, `server.ts`, but nothing invalidates already-issued DS env — adopted containers keep the old secret forever, `container.ts` adopt-never-recreate).
- **Fix:** acceptable for a single-user local tool, but: document the trust statement explicitly in README ("any process running as the portal user can read/write office documents"), and add a "rotate secret" setting (new random file + remove/recreate DS container, since env is only set at create).

**S4. Callback download URLs (`body.url`, `changesurl`) are fetched with no scheme/host validation — SSRF surface tied to the shared secret.**
- `callback.ts:201` `fetchWithRetry(url, …)` fetches whatever the signed envelope says; also unbounded response size (no cap on the downloaded buffer or the bytes persisted).
- **Why it matters:** the URLs come from JWT claims signed with the shared DS secret — normally trustworthy. But combined with S3, anyone holding that secret can make the portal process issue server-side GETs to arbitrary URLs (metadata endpoints, other local services) and write multi-GB bodies into the library. The ooxml reader has deliberate size caps; this path does not.
- **Fix:** validate scheme is `http`/`https`, restrict the host to the DS origin (`state.origin`) or at minimum block link-local/private ranges unless they match the recorded origin; cap downloaded bytes (e.g. 256 MB, matching `ooxml.ts MAX_ENTRY_BYTES`).

**S5. Wake-on-mention is an unauthenticated prompt-injection + standing access-grant channel into other agents' home chats.**
- `ping.ts:processComment` → `officeWakeMessage` (raw comment text) → queued; drained by `tools.ts:439` via `pi.sendMessage({ customType: "office-comment-ping", content: entry.text, display: true, details }, { deliverAs: "followUp", triggerTurn: true })`. Any co-editor of any doc can type a comment mentioning an agent/project name; that verbatim text then triggers a turn in the target home chat *with* a fresh edit grant on the document and the sentence "You have edit access to this document for this task".
- **Why it matters:** the woken agent's full toolset (not just office tools) sees attacker-authored instructions. This is the feature by design, but nothing marks the text untrusted, scopes the instruction to office tools, or gates cross-project grants — a mention from an ownerless human-created doc can wake any named agent/project.
- **Fix (discuss):** prefix wake text with an explicit "untrusted document content" marker and narrow the instruction ("answer using office_* tools only, nothing else"); consider requiring doc-owner confirmation for mentions that grant to *other* projects' homes. At minimum, record this as an accepted risk in the README deferred section.

### 🟢 [nit] / 💡 [suggestion]

**N1. `importFile` follows symlinks — allowed-parent is checked on the logical path only.**
- `server.ts POST /import` checks `portal().folders.allowed(path.dirname(abs))` on the resolved-but-not-realpath'd path; `store.ts:371,407` then `statSync`/`copyFileSync` follow symlinks. A symlink planted inside a workspace folder (e.g. `notes/x.docx → /elsewhere/secret.docx`) passes the check and imports the target. Low value here because agents already have host-filesystem access as the same user, but the containment intent is undercut. **Fix:** `fs.realpathSync` the resolved path and re-run `folders.allowed` on its parent (cheap; closes the class entirely).

**N2. No size cap on import.** `store.ts:importFile` copies a file of any size into the library; the UI hints "agent workspace folder" only. **Fix:** reject above some ceiling (e.g. 100 MB) or warn — mirrors the callback download concern in S4.

**N3. Callback logs the full `body.url` verbatim.** `callback.ts:467` (`could not download ${body.url} …`). If a DS build ever puts query tokens in those URLs, they land in portal logs. **Fix:** log host+path only, or omit the URL on failure lines.

**N4. Failed-comment retry is unbounded.** `ping.ts:handlePersisted` — a comment whose processing throws stays "unseen" and is re-reported (log + attempt) on *every* subsequent persist until it succeeds; a persistent condition (e.g. corrupt index) spams logs every save. **Fix:** keep an attempt counter in the state file or drop after N failures with a single log line.

**N5. Tickets are replayable within their 10-minute window.** `tickets.ts:verifyTicket` never consumes a ticket; the loopback GET (and, in container mode, every other container in the shared netns — the listener's "loopback" is only private to that netns) can re-fetch any document bytes as long as the token lives. The token also appears in DS-side access logs under the named data volume. Low risk (read-only, one doc, 10 min, no session needed), but **💡 fix if trivial:** consume-on-verify with an in-memory `Set<token>` or bind the ticket to the minted mtime and reject when `store.getDoc().mtimeMs` differs.

**N6. No user scoping on human-facing routes — correct for v1, worth stating.** Every route (`GET/POST /documents…`, `/import`, `/editor-config`) authorizes by the portal's shared-password login only (confirmed in `core/server/src/auth.ts`: one cookie gate, no per-user identity) and any session can read/edit/delete *all* documents regardless of the `owner`/`grants` chips shown in the UI. The asymmetry with the agent tool scoping is deliberate (`server.ts:55-58` comment), but a future multi-user SSO rollout (the oidc router exists) would silently inherit this; flag in the README deferred list.

**N7. `verifyJwt` accepts tokens without `exp`.** Only internal minters omit exp (none in production paths), so it's harmless today, but a defensive reject (`exp` required) would shrink the API. 🟢

---

## What's good

- **Crypto done right:** `jwt.ts` pins `header.alg === "HS256"` exactly (rejects `none`, RS/algorithm-confusion), recomputes over the *transmitted* segments, and uses `timingSafeEqual`; `tickets.ts` uses constant-time HMAC comparison with a length pre-check. Secret is 256-bit from `crypto.randomBytes`, stored 0600 with explicit chmod (umask-proof), regenerated if truncated.
- **Envelope binding is the standout design:** `callback.ts` takes `key`/`status`/`url` from the *signed* JWT claims, never the unsigned JSON body — a valid token alone cannot POST an arbitrary `{key,status,url}` overwrite. The "verify once, reuse claims" note avoids an expiry-race double-verify as well.
- **Revision gate + double-save memo** (`callback.ts` stale-gate, `store.ts:persistBytes`) implement the promised zero-tolerance mtime check with a coherent treatment of DS's duplicate force-save pass; every failure answers 200/`{"error":1}` per the DS contract.
- **Agent tool authorization is tight:** `tools.ts visibleDoc` scopes list/read/edit/comments to `docsForHome` (owner ∪ grants) and answers out-of-scope ids with the *identical* "no document with that id" text as nonexistent ones — no existence oracle across homes. Duplicate folder names refuse wakes rather than guessing (`ping.ts resolveMention`).
- **Zip handling is defensively capped** (`ooxml.ts`: 256 MiB per-entry, 1 GiB total advertised-uncompressed cap checked before any entry is retained; memory-only reads/writes — no zip-slip surface since parts never touch the filesystem under attacker names). Titles are sanitized before becoming filenames (`store.ts assertSafeTitle`), docIds come from a crypto-random 36^6 space, index writes are atomic tmp+rename.
- **Web client is XSS-clean:** React auto-escaping throughout (no `dangerouslySetInnerHTML`/innerHTML anywhere in the slice); only dynamic URLs are server-built `api.downloadUrl/exportUrl` with `encodeURIComponent`; api.js `src` comes from the server-minted origin, not user input; CSRF is covered platform-wide by the `SameSite=Lax` login cookie (`core/server/src/auth.ts:231`).
- **Loopback listener hygiene:** 405/404 before body reads, 2 MB envelope cap with backpressure, no percent-decoding of the ticket path, unref'd intervals, `closeAllConnections()` on stop.
- `:latest` image tags are refused with a clear reason; adopted containers are never recreated or restarted (no surprise restarts).

## Open questions

1. **DS multi-session callbacks with one shared user id** — does OnlyOffice fire status 2/4 per tab while another session is still connected, and do those envelopes carry a `users` snapshot? This determines whether S2's early-unlock direction is exploitable in practice. A test against the pinned image would settle it (deferred to M0 handshake work).
2. **Community image 10.0 nginx bind + JWT coverage** — confirm which endpoints require tokens with `JWT_ENABLED=true` and where `listen 80` binds (drives S1 severity; also whether the client's bare `loadScript(apiJs)` without a `?jwt=` param is accepted by that tag).
3. **Multi-portal / multi-user roadmap** — per-instance secrets, per-user document scoping, and per-comment grant expiry are all deferred; N6/S3 should be revisited when OIDC SSO gains real per-user identities.
4. **Port 80 on the portal host in host mode** — availability (conflicts with existing services) is out of slice but coupled to S1's fix choice.
