# Implementation plan: pithagoras-office (issue #280)

Status: proposal -- revised 2026-10-23 three times: (1) technical review
fixes, (2) own document library + live co-editing, (3) agent/project ownership
with @mention grants + global Office tab (user-confirmed decisions).
Ready for re-review.
Issue: https://github.com/thecodacus/pithagoras/issues/280 — "Concept: pithagoras-office extension — embedded OnlyOffice Document Server (sidebar + agent tools + comment wake)"

## 1. Goal

Add an opt-in **pithagoras-office** extension that embeds OnlyOffice Document
Server (DS) in a portal-managed container and gives the portal three things:

1. A sidebar page where users open real Office files (.docx/.xlsx first, .pptx
   later) in the full DS editor.
2. Agent tools so agents can read and edit those same files (OOXML-aware),
   gated by ownership + mention-grants and revisions; an open human session
   triggers forcesave-first ordering, not refusal (co-editing is the default,
   §5.7).
3. Wake-on-mention: a comment containing @agent / @<name> /
   @project:<name> wakes the named agent or project in its home chat with the
   quoted comment and grants it access to that one document (docs ping
   pattern).
4. A global **Office tab** on the main nav -- the full library, styled like an
   office suite (not portal card chrome), with a full-bleed editor.

Motivation (from issue): pithagoras-docs is deliberately barebones markdown;
office documents are a real user need where "good enough" means a real Office
editor. DS was chosen over Collabora because of the callback/locking model and
the official ecosystem (see §2 — the MCP assumption turns out to be weaker
than the issue states).

## 2. Decisions on the issue's open questions

### 2.1 Storage layout → own document library in the extension's dataDir (NOT chat folders)

Documents live in **pithagoras-office's own folder** -- `portal.dataDir()`
(verified API, packages/extension-api/server.d.ts:844; precedent: understory
keeps its settings there): `docs/<docId>/<title>.<ext>` plus a metadata index
(`index.json`; per-doc JSON, SQLite only if it ever needs queries). docId is
generated (slug + short random suffix) -- never a chat-relative path. Chat
folders are untouched: office works like real office software with its own
library; documents reach agents and projects through ownership and mentions,
not through chat membership.

**Ownership / grants (user-confirmed model)**: the discriminator is folder-based -- `portal.folders.list()` returns every agent home and project as `AgentFolder{path,name,kind:"agent"|"project"|"chat",home?}` (server.d.ts:91; a `Chat` carries no kind), and the chats.extend factory resolves each chat's workspace to that folder kind. Each index
entry carries `owner: <home chat id> | null` -- the home of the agent/project
that created the doc (docs a human creates from the global tab are ownerless)
-- plus `grants: [{chatId, commentId, at}]`. Rules:
- An agent/project may edit only docs it **owns** or was **granted**; its
  office_* tools and home-chat panel see exactly that set.
- Ownership is standing access for the creating agent/project's context; any
  other agent/project gets access to **that one file only** by being mentioned
  in a comment of it (§5.4) -- never library-wide.
- Human UI access (global tab, opening documents, import/export) is
  unrestricted; only agent tooling is gated.

Import/export to chat folders are first-class operations (copy the file in or
out through portal.files), so nothing is stranded and Files-extension users
got a copy whenever they want one there.

SUPERSEDED by PR #307 (the implemented extension): manual import is GONE.
The library instead shows every .docx/.xlsx found across the agent homes and
projects -- `portal().folders.list()` is the root source -- indexed automatically
at boot (after settleKept) and on POST /documents/rescan, IN PLACE (DocMeta.path);
export to chat folders remains deferred as listed below. DS's own storage
(`/var/www/onlyoffice/Data` volume) stays an ephemeral working cache -- every
save round-trips to the library (§4 mechanism), so wiping the container loses
nothing.

Rejected alternatives: (a) chat-folder storage (first draft of this plan) --
coupled every document to one chat, made "restrict to a project" awkward, and
left no room for library semantics (rename history, trash, versions);
(b) DS's own storage (issue's option B) -- opaque, un-backupable, breaks the
stable filesystem path the agent tools need.
M1 verifies dataDir gets the same persistence/backup treatment chat folders
do; if not, a note lands in the docs.

### 2.2 Agent surface → built-in OOXML tools, NOT MCP

The issue assumed the official MCP server (ONLYOFFICE/docspace-mcp) could serve
the agent. **Verified against the repo (public, MIT): it does not.** Its README
shows it targets ONLYOFFICE Docspace — the cloud SaaS product — requiring
`DOCSPACE_BASE_URL` + `DOCSPACE_API_KEY`, and its toolset is workspace-level
(rooms, folders, permissions, people directory), not document-content editing.
Pointing it at our private embedded DS would be wrong twice: wrong product and
wrong granularity, plus data would have to leave the machine.

So v1 registers plain extension tools in agent/project home chats only via
`portal.chats.extend((pi, chat) => …)` (the factory knows its chat; ownership
scoping in §5.5), OOXML-aware and docs-extension-style
(named by id, base-revision writes, coded error prefixes). This keeps edits
deterministic, local, and gate-able on lock state.

Future (post-v1, still open): a community MCP for on-prem DS could be wired
with `portal.mcp.set("…", {command:"docker", args:[…]})` behind an opt-in
setting; Docspace-cloud mode if a user has their own key. Not in this plan.

### 2.3 Scope → multi-document, single human identity per session

- Multi-document: any number of documents in the library (§2.1); each open
  editor is tracked independently by its DS `document.key` (key = docId +
  revision hash).
- Co-editing inside the editor works as-is (DS handles it). Our lock model only
  tracks **someone vs. nobody** editing a document (from callback `users`
  lists), which is all the agent needs.
- v1 uses one portal user identity for the DS session (`editorConfig.user`
  from the requesting portal session). Per-user identities/profiles: later.

### 2.4 Packaging → opt-in package requiring pithagoras-docker

`package.json`: name `pithagoras-office`, keywords `["pi-package"]`,
`"pi": {}`, `"pithagoras": { client, server, style }`, with the dependency
**nested** as `"pithagoras": { ..., "requires": { "pithagoras-docker":
"^1.1.0" } }` (core reads requires only under that key -- a top-level
`requires` would not resolve; precedent: understory's package.json).
**Not** added to `extensions/defaults.json` — it stays opt-in; enabling is an
explicit settings-page action that starts the container and pulls the image
(~GB-scale, ~4 GB RAM recommended at runtime — surfaced as a warning before
start). Extensions are standalone npm packages (not root workspaces); the root
`scripts/build-extensions.mjs` picks the new directory up automatically —
verify in M1.

### 2.5 Decisions (confirmed on re-review + one picked default)

- **D1 ownership (confirmed)**: documents are owned by the agent/project that
  created them -- not bound to arbitrary chats; human-created docs are
  ownerless. Model in §2.1/§5.4.
- **D2 co-editing (confirmed)**: live agent co-editing is ON by default and
  must always work (§5.7, forcesave-first ordering); a setting to disable it
  remains as an escape hatch.
- **D3 grant lifetime (picked, flag for re-review)**: a mention-grant (§5.4)
  stays on the doc until revoked from the UI -- multi-turn tasks need it;
  strict per-comment expiry deferred to M4. Grants are scoped to that one
  file and every grant/revoke is audited.

## 3. Architecture

    +--------------------- portal UI (browser half) ----------------------+
    | global nav page "Office": library browser <-> full-bleed editor      |
    |   OfficeEditor: DocsAPI.DocEditor placeholder + minted config/JWT    |
    | per-home chat.panel (owner/granted docs), tool cards, settings page  |
    +-------------+                                       ^---------------+
              | session auth (/api)                        | DS origin (see
              v                                           | reachability, M0)
    +----------------- portal server half ------------------------------+
    | A) /api/x/pithagoras-office/... -- session-gated (UI):              |
    |    documents CRUD * state * editor-config (mints JWT)               |
    | B) standalone loopback listener (127.0.0.1, in-process,            |
    |    OUTSIDE /api so the login middleware never sees it):             |
    |    GET /doc/<ticket>  <- DS container fetches document.url          |
    |    POST /callback   <- DS POSTs status/actions/users/url/changesurl |
    | C) shared state: lock state machine * wake queue (docs ping pattern)
    |    * tools via chats.extend (lock- + revision-gated)                |
    +------+---------------------------+---------------------------------+
           | document bytes (HMAC ticket,  no cookie needed)              |
           v                      | POST callback; GET the saved file
    +-------+--------------------+------ docker: onlyoffice/documentserver:<pinned>
    | editor UI served by DS stock nginx -- under shared networking it     |
    | listens :80 on ALL interfaces of the shared netns (PortBindings are  |
    | ignored); browser reach = local-only or portal proxy route, M0 #2   |
    | internal storage volume (cache only)                                |
    +---------------------------------------------------------------------+
   office library in the extension dataDir: docs/<docId>/ + index.json        
   -- source of truth (owned by the creating agent/project; mention grants
   per file; NOT in chat folders)

Components and where they copy from:

| Component | Source pattern in repo |
|---|---|
| host.ts / container lifecycle | extensions/understory/src/server.ts + src/server/host.ts (setPortal/portal()/docker(); adopt on boot; setInterval(lookAfter, 30_000).unref(); dependents don't self-stop) |
| Docker API usage | extensions/docker/src/api.ts via portal.extensions.use<Docker>("pithagoras-docker"): images.ensure (progress), containers.create/start/stop/logs/exec/adopt/inspect, volumes.*, sharedNetwork() |
| Sidebar page + panel + tool cards | extensions/docs/web/client.js (nav.page documents -> DocumentsPage; chat.panel "documents"; one chat.tool entry per tool with "Open in Documents" button) |
| Wake on mention | extensions/docs/ping.js: server queues {text, details} per chat -> portal.chats.tell(chatId,{type:"ping"}) rings bus channel UI_RECEIVE="pithagoras:v1:ui:receive" -> per-chat pi extension drains queue with pi.sendMessage({customType, content, display:true, details}, {deliverAs:"followUp", triggerTurn:true}) |
| Tool style (ids not paths, base revision, coded errors) | extensions/docs/tools.js header + error codes (not_found/exists/revision_mismatch/too_large/invalid/refused -- office adds: unsupported_format, corrupt; `locked` is reserved, only reachable if co-editing is disabled or for M4 xlsx writes) |
| package skeleton, build.mjs (esbuild from repo node_modules; deps.js missingDependencies -> npm ci --ignore-scripts) | extensions/docs/ |

## 4. Verified OnlyOffice integration facts (official docs, current state)

Source: https://api.onlyoffice.com/docs/docs-api/usage-api/callback-handler
(fetched and read during exploration; current docs describe DS 10.x behavior).

- **Editor embedding (current documented entry point)**: the page loads the
  script /web-apps/apps/api/documents/api.js and calls
  new DocsAPI.DocEditor(placeholder, config) -- DS replaces the placeholder
  with its own iframe to /web-apps/apps/documenteditor/main/index.html. A raw
  ?config=<JWT> query URL is NOT the documented embedding (older builds' path
  was webapps/onlyoffice/editor/index.html; unverified on 10.x -- M0 may note
  it, but v1 uses api.js + DocEditor, which is also required for client-side
  events). Config object: top-level documentType ("word"|"cell"|
  "slide"|"pdf"|"diagram"), type:"embedded", title, height/width, token field,
  document{fileType,key,title,url}, editorConfig{callbackUrl,mode,user{id,name},
  customization...}, optional client-side events{}. Since DS 7.1 the signed
  parameter list is "strictly regulated": sign exactly what you send (the
  official sample includes document.permissions and editorConfig.mode -- verify
  the exact set on the pinned build in M0).
- **Callback body** (POST to callbackUrl): required key + status; plus
  actions[] ({type: 0 disconnect | 1 connect | 2 forcesave-click, userid}),
  users[], url ("link to the edited document to be saved", present for status
  2/3/6/7), changesurl (changes archive, status 2/3/6/7),
  history{changes,serverVersion} (status 2/3), filetype, forcesavetype
  (status 6/7: 0 command service, 1 Save button, 2 timer, 3 form submit),
  formsdataurl (status 6 + forcesavetype 3), userdata.
- **Status semantics** (current numbering -- differs from older blog posts):
  - 1 = being edited; sent on every user connect/disconnect (our lock signal, with actions/users)
  - 2 = ready for saving -- closed after changes (~10 s after close); host downloads url and persists
  - 3 = document saving error
  - 4 = closed with no changes (-> unlock)
  - 6 = force-saving performed, editing continues (download + persist, stay locked)
  - 7 = force-saving error
- **Save-back mechanism (verified in the official Node.js example)**: on status
  2 the storage service does fetch(req.body.url) -> streams to disk, then must
  answer {"error":0}; anything else makes the editor show an error. There is no
  other push of the full file -- this GET of url IS the save.
- **JWT**: since DS 7.2 JWT is enabled by default (auto-generated secret).
  The internal local.json has per-direction enable/secret sections
  (inbox/outbox/session), but the community Docker image's documented env vars
  are only JWT_ENABLED / JWT_SECRET / JWT_HEADER / JWT_IN_BODY -- a single
  JWT_SECRET covers config tokens AND callback verification in every direction
  (no per-direction env vars; editing the container-local local.json is
  regenerated on restart, so env is the documented mechanism). v1 therefore
  generates one secret and passes it as JWT_SECRET; DS still verifies our
  signed configs and signs/verifies callback traffic with it. A per-direction
  two-secret setup (inbox for config signing, outbox for callback verification)
  would need local.json mount/patching -- deferred unless M0 proves a supported
  way on the pinned image.
- **Client-side DocEditor methods (documented, fetched)**: the host page's
  DocsAPI.DocEditor object exposes -- refreshFile(newConfig): "updates the file
  version without reloading the editor" (officially called in answer to the
  editor UI's onRequestRefreshFile event; parameters must stay documentType/
  type/events); refreshHistory({currentVersion, history:[{created,key,user,
  version, changes?, serverVersion?}]}): renders a version history inside the
  editor, with per-version change data when changes+serverVersion match; and
  setHistoryData({url, key, previous{...}, changesUrl}): links for viewing a
  stored version. Also createConnector() (Automation API, callable in
  onDocumentReady), requestClose(), denyEditingRights(message). Consequences:
  an external revision can reach a doc that is open in someone's editor
  WITHOUT a full page reload -- the building block of live co-editing (§5.7);
  our stored revisions + changes.zip archives can power the editor's own
  version-history UI. Programmatic push (calling refreshFile outside the event) and whether
  client-side config events are reachable from our page (same-origin or via a
  postMessage bridge): M0 territory.
- **Comment events**: the current official callback body does **not** include
  commentadd/commentremove push events (no events array in the documented
  parameters). Comment wake is therefore implemented server-side from the saved
  file (§5.4) -- this supersedes the issue's assumption that DS pushes comment
  events to the callback. Client-side config.events.onCommentAdd exists (runs
  inside the editor page) and can later feed a postMessage bridge for live UI,
  but it is not the wake path.

## 5. Component design (server half)

### 5.1 Lifecycle -- src/host.ts + src/container.ts

- host.ts: module-level let current: ServerPortal; setPortal(portal), portal(),
  docker() accessors (understory shape). Default export of server entry: set
  portal -> register routes -> void settleKept().catch(log) in background
  (adopt container + volume if they exist) -> setInterval(lookAfter,
  30_000).unref(); cleanup clears the timer.
- Container spec (Docker Engine ContainerCreate body):
  - image: **pinned tag** onlyoffice/documentserver:<X.Y> -- exact tag chosen in
    M0 spike; never :latest (image changes must not silently alter callback/jwt
    behavior).
  - env/volume per JWT mechanism from M0; named volume for /var/www/onlyoffice/Data.
  - network: await docker.sharedNetwork() HostConfig mode ("host" or
    container:<portal-id>), so the container reaches the loopback listener for
    document.url/callback. Under shared networking, Docker PortBindings are
    IGNORED and there is no published port to persist: DS stock nginx simply
    listens on :80 of the **all interfaces of the shared netns** -- in host
    mode that is the host's 0.0.0.0:80 (collision risk if anything else binds
    it, plus LAN/tailnet exposure). There is no documented listen-address env
    for DS. The DS origin is fixed by deployment shape (127.0.0.1 in host
    mode; the container-local equivalent otherwise) and must be recorded in
    ds.json on create.
  - Browser reach to that origin is a **decision, not an assumption** -- see
    M0 spike 2 (in-container nginx bind override vs portal reverse-proxy route
    vs declared local-only access). v1 ships with whatever M0 picks; the plan
    no longer claims loopback-only publication.
- Settings (dataDir/settings.json): {enabled, imageTag}. Start/stop
  from settings page; lookAfter keeps a user-started container alive but never
  resurrects one the user stopped. Status route reports: container state, image
  pull progress (images.ensure onProgress callback, held in memory), DS version
  (exec into container).

### 5.2 Documents & tickets -- src/store.ts + src/tickets.ts

- Documents CRUD in the extension's own library (`portal.dataDir()`): layout
  docs/<docId>/<title>.<ext> + index.json entries {docId, title, ext,
  createdAt, updatedAt, sizeBytes, mtime(revision), owner: chatId|null,
  grants:[{chatId,commentId,at}], createdBy}. Extension filter: .docx/.xlsx (.pptx later). All reads/writes are
  plain node:fs inside the extension's own directory -- the verified 1 MB cap
  (MAX_EDIT_BYTES, core/server/src/workspace-files.ts:47) applies to
  portal-managed files, not ours, so >1MB Office files work natively here.
  Persist stays write-to-temp + rename with an explicit mtime conflict gate
  (|mtimeMs - expected| > 1 ms => refusal); delete = move to .trash/ with a TTL.
- **Ownership/grants gate agent access**: home-chat panels, tool registration
  in the chats.extend factory (tools register only in agent/project homes),
  and office_read/office_edit checks. Human UI routes are unrestricted; the
  loopback GET /doc/<ticket> stays HMAC + expiry only (DS-facing, no user
  context).
- Import/export to chat folders: copy in/out via portal.files.open() fd + fs;
  import performed from an agent/project context sets that home as owner, else
  ownerless (keeps Files-extension users and "send this doc to my chat"
  working).
- Blank templates: minimal valid docx/xlsx generated with a small zip library
  (no zip/jwt/docx dep exists in the monorepo lockfile today -- add one pure-JS
  zip lib, proposed jszip; everything else is node:crypto/https/fs).
- **Cookie-free container endpoints (design decision, not open)**: verified in
  core that EVERY portal route is session-gated -- app.use("/api", requireAuth)
  (core/server/src/server.ts) and extension routes mount at /api/x *after* the
  login (extension-host; packages/extension-api/server.d.ts). The DS container
  holds no session cookie, so a ticketed GET AND the callback POST would both
  401 if registered on portal.router. Design: a tiny standalone http listener
  in the same process, bound to **127.0.0.1 only**, serving exactly two paths:
  - GET /doc/<ticket> -- mint per-open HMAC-SHA256 tickets: token =
    base64url(docId|expMs|hmac(secret, docId+exp)), 10 min expiry, verified
    with timingSafeEqual; answers the library file's bytes (plain fs, §5.2 --
    no portal files size cap on our own dir). This is document.url in the
    minted config.
  - POST /callback -- handled per §5.3 (DS -> listener direct; nothing passes
    through the login middleware).
  sharedNetwork() puts the container on this loopback in BOTH deployment
  shapes (host: the host's; container: the portal container's), so one design
  covers both. No other endpoint lives on the listener.

### 5.3 Callback & lock state machine -- src/callback.ts

Served by the loopback listener (§5.2), not a portal route. Verify JWT
(secret; reject with error code if invalid -> answer {error:1}), then branch
on status exactly per §4:

| status | lock | persist | notes |
|---|---|---|---|
| 1 | set users[] from body (lock = users.length>0) | -- | actions tell join/leave/forcesave; emit UI event |
| 2 | unlock after persist | fetch url -> temp file in dataDir -> fs write+rename over the library file with the mtime gate of §5.2 | bump revision (mtime); store changes.zip from changesurl under dataDir/history/<doc>/<rev>.zip; run comment-diff wake (§5.4) |
| 3 | keep | log + audit.record | answer {error:1} only if we also failed internally |
| 4 | unlock | -- | no change on disk; comment diff still runs cheaply on next persist |
| 6 | keep locked | same persist as 2 without unlock | timer/Save-button forcesave while session continues |
| 7 | keep | log + audit.record | force-save error |

Persist must be resilient: retry fetch a few times (DS can lag), never delete
the existing file on failure (temp+rename), and the file's mtime/sha is the
revision tools compare against. document.key includes the revision hash so DS
never serves stale cached content after an agent edit.

### 5.4 Wake on comment mention -- src/ping.ts (server-side)

On every persist (status 2/6): unzip the saved docx, parse word/comments.xml
({id, author, date, text = joined w:t}), diff against the last-seen comment set
stored in dataDir/state/<doc>.json. For each **new** comment, resolve its mentions (grammar below), then per
mention:

**Mention grammar (user decision)** -- parsed from the comment text:
- `@agent` (literal token) -> the document's **owner**, i.e. the agent/project
  that created it; ownerless docs: ignored + logged.
- `@project:<name>` -> the project with that display name (case-insensitive
  exact match).
- any other `@<name>` -> the agent with that display name; its work starts in
  that agent's home chat.
- Unresolvable/duplicate names: no wake, logged (risk item -- no silent
  disambiguation).

**Routing + grant (the permission model):**
1. Resolve mention -> target chatId (home of the named agent/project). Create
   a grant if absent: doc.grants += {chatId, commentId, at} -- mentioning is
   what authorizes that entity for this file; grants persist until revoked
   from the UI (D3), are scoped to this one doc, audited.
2. Queue wake entry for the target chat: {text: officeWakeMessage(docTitle,
   author, commentText), details:{docId, commentId}}, deduped by comment id
   per chat.
3. portal.chats.tell(targetChatId, {type:"ping"}) (rings UI_RECEIVE bell; text stays queued server-side -- exact docs pattern).
4. The target home's pi extension (registered from the same chats.extend
   factory) listens on UI_RECEIVE and drains via
   pi.sendMessage({customType:"office-comment-ping", content, display:true,
   details}, {deliverAs:"followUp", triggerTurn:true}).

When the M0 client-API spike confirms client-side event access (same-origin or
via a postMessage bridge), a new mentioning comment can wake immediately
instead of after the next persist; the save-based diff stays the guaranteed
fallback (both dedupe by comment id and create grants exactly once).

Wake message shape follows docs' wakeMessage(): doc title, quoted comment,
doc id, and "you have edit access to this document for this task; answer with
office_* tools".
v1 wake targets **docx only**: xlsx does have comments, but they live in a
different part layout (xl/commentsN.xml + VML anchors + sheet rels), not
word/comments.xml -- parsing that layout is deferred to M4 (plan wording
corrected: it was "xlsx has no comments.xml", which is false).

### 5.5 Agent tools -- src/tools.ts (chats.extend)

Docs-style: id = relative path, writes carry baseRevision (= mtime), refusals
are Errors prefixed with codes. Revision gate (mtime conflict) on every
mutating tool; an open human session is NOT a refusal -- forcesave-first
ordering per §5.7 (co-editing default ON).

- office_list -> [{id, title, ext, sizeBytes, mtime, locked, users}]
- office_create {title, type:"word"|"cell"} -> {id} (from template; owner = this home)
- office_read {id} -> extracted text (paragraph-delimited for docx; grid of cell values for xlsx) + comments [{id, author, date, text}] + lock state. Word: word/document.xml runs; XLSX: sheet XMLs with sharedStrings.
- office_edit {id, ops:[{quote, replacement}], baseRevision} -> paragraph/run level replacement in document.xml (docs' quote philosophy: quote_not_found / quote_ambiguous), rewrite zip preserving every other entry byte-for-byte. Safety against a live session is ordering, not refusal (§5.7): a dirty human session is forcesaved first (status 6 persists before our write); otherwise the edit is queued until all users closed; baseRevision is checked either way, so a stale edit still fails with revision_mismatch.
- office_comments {id} -> read-only thread list (v1).

Stretch (M4): office_comment_add -- injecting a comment requires editing
word/comments.xml + body ranges + [Content_Types].xml/rels; high corruption risk
to user files. Only with a strict round-trip validator (refuse on any schema
surprise); otherwise agent replies stay in chat + text edits.

Tool registration is ownership-scoped: office_* register only in agent/project home chats, and there they operate only on docs where that home is **owner** or holds a **grant** (§5.4), so office_list returns exactly its documents and office_create sets owner to the home (confirmed D1). With co-editing default ON (§5.7) an open human session no longer refuses -- it triggers forcesave-first ordering; the revision gate (baseRevision) always remains.

### 5.6 Security

- JWT secret: ONE crypto.randomBytes(32) value, generated once, stored 0600 in
  dataDir (extension's own 0700 dir), passed to DS as JWT_SECRET and used for
  both config signing and callback verification (see §4 -- the community image
  exposes no per-direction env vars); constant-time compare.
- Listener endpoints (/doc/<ticket>, /callback) bind 127.0.0.1 only -- that is
  under our control. The DS web origin (:80 in the shared netns) is NOT
  loopback-only by construction; its exposure is handled by the M0 spike 2
  decision and documented on the settings page, not claimed away.
- Ticketed document route: expiry + HMAC only (DS-facing; user-level access
  is gated at config mint and in the tools, §5.2). No other auth bypass.
- audit.record() on: container start/stop, document create/rename/delete,
  every grant + revoke, import/export, every persist, every agent edit,
  every wake (subject=doc id, chatId set).

### 5.7 Live agent co-editing (default ON -- user-confirmed; disable setting as escape hatch)

There is no official API to stream external edits into DS's live session state
(DS owns the document once a session opens and only ingests new content via a
key/config change), so "live" is built from the documented building blocks in
§4. Fidelity tiers, best first:

1. **Refresh tier (v1, the default behavior)**: office_edit succeeds on a doc
   with an open human session -> persist new revision + store changes snapshot
   -> mint fresh config (new document.key + ticket url) -> deliver it to every
   same-origin editor showing the doc via DocEditor.refreshFile(config)
   (programmatic push -- M0 verifies DS honors it outside
   onRequestRefreshFile; fallbacks: wire the editor UI's own update-request
   event, which is the documented path, or badge "agent updated this document
   -- refresh" for the human). Unsaved human changes are never clobbered: if
   the session reports unsaved state (appstate), trigger a forcesave first and
   apply after its status-6 persist, else queue until clean.
2. **History tier (v1 always)**: every agent revision is registered via
   refreshHistory({history:[...stored changes.zip + serverVersion...]}) so it
   appears in the editor's own version-history UI with a diff -- true "real
   office" feel even when live push is off.
3. **Connector tier (M0 spike only)**: createConnector() (Automation API) in
   onDocumentReady -- if the client-side connector can apply text operations
   to the open session, agent ops stream into the live document with no
   refresh at all. This is the only path to true character-level co-editing;
   it depends on behavior the docs treat as secondary, so it stays a spike,
   not a commitment.

## 6. Component design (browser half) -- web/

Copy the docs extension's client structure:

1. **Global nav.page** {id:"office", title:"Office"} -- the full library at
   /x/pithagoras-office/office, deliberately styled like an office suite with
   its own minimal chrome (user direction: pithagoras card style does not fit
   an office suite): thin toolbar (container start/status + pull progress when
   stopped; version when running), document list/grid of ALL docs (title, ext
   icon, owner badge, grant badges, mtime, lock badge from /state polled every
   ~5 s), create button, row menu: open, import/export to chat folder, revoke
   grants, delete. Row click or ?doc= -> full-bleed OfficeEditor in the same
   tab (thin header only; docs precedent: DocumentsPage switches on ?doc=).
   If M0 leaves browsers on the direct DS origin, also offer "open at DS" as a
   plain link.
2. **Per-home chat.panel** "office" (agent/project homes): compact list of the
   docs this home owns or has grants on + lock badges; onExpand -> navigate to
   the editor page with ?doc=.
3. **OfficeEditor**: header (title, back-to-list, live "N editing..." lock
   badge) + the editor placeholder that DocEditor fills (DS creates its own
   iframe). Page requests POST /editor-config {doc}; server mints the
   JWT (+ mode/permissions per the regulated signing set); a placeholder div is
   filled by new DocsAPI.DocEditor(el, config) -- the documented api.js pattern
   (§4), with document.url and callbackUrl pointing at the loopback listener.
   When the M0 client-API spike confirms the push surface (same-origin or via
   postMessage bridge), this page additionally calls: refreshFile() delivery
   for co-editing (§5.7), refreshHistory()/setHistoryData() for stored agent
   revisions, and appstate/config events for an instant comment-mention wake
   plus a no-poll lock badge.
4. **chat.tool** entries per office_* tool: result card with doc title and an
   "Open in Office" button (docs tool-card pattern).
5. **settings.page** "office": enable/disable, image tag display (pinned),
   start/stop, status block, RAM warning (~4 GB recommended) shown before the
   first start, data locations, co-editing toggle.
6. style.css: lock badge + grant badges, office-suite list chrome for the
   global tab (deliberately not portal card style).

## 7. Tests

- **Unit** (extensions/office/test/*.test.mts, run by the root
  npm test glob node --import tsx --test ... extensions/*/test/*.test.mts):
  ticket mint/verify/expiry; state machine over synthetic callback sequences
  (join -> leave-with-changes: file updated + unlocked; forcesave keeps lock;
  invalid JWT rejected; temp+rename atomicity); docx fixture round-trip
  (extract text; quote replace preserves other zip entries byte-for-byte;
  comments.xml diff detects exactly the new mentioning comment, dedupes by id);
  ownership/grant scoping (doc owned by home A absent from home B's tools/list;
  a mention-grant makes it editable for B; ownerless docs invisible to all
  agents);
  revision-mismatch refusal in office_edit; live-mode ordering (dirty session
  -> forcesave scheduled before refreshFile config mint).
- **Integration** (docker-gated, skip when docker.available() is false):
  container boots from image (CI-cached); the loopback listener answers a
  ticketed document GET and a synthetic callback **without any session cookie**
  (HMAC + expiry enforced); a document >1 MB
  round-trips persist in the library store; editor page loads the
  DS editor via DocEditor (or the portal proxy route if M0 picks that) for a
  minted config; full save loop with a scripted callback + real DS-hosted url
  fetch.
- **Playwright** (test/browser/office.spec.mts, repo's @playwright/test setup):
  office page lists documents; start-container flow shows progress then badge;
  opening a doc renders the DS editor in the page (DocEditor, or proxy route if
  M0 picks that) with no error banner; settings start/
  stop round-trips. Skipped when docker is unavailable in the test env.

## 8. File layout (new)

    extensions/office/
      package.json          # pithagoras-office, keywords ["pi-package"], "pi": {},
                            # "pithagoras": {client, server, style,
                            #   requires: {"pithagoras-docker": "^1.1.0"}}  # nested -- core reads it there
      build.mjs             # esbuild from repo node_modules (docs pattern)
      deps.js               # missingDependencies -> npm ci --ignore-scripts
      src/host.ts           # portal registry + 30 s lookAfter loop
      src/container.ts      # create/adopt/stop, DS origin recording (ds.json), status
      src/settings.ts       # dataDir settings.json
      src/jwt.ts            # HS256 sign/verify (node:crypto)
      src/tickets.ts        # HMAC download tickets
      src/store.ts          # library in dataDir: index.json, docs/<docId>/, .trash/;
                            # owner + grants; import/export to chat folders; templates (jszip)
      src/live.ts           # live co-editing: refreshFile/history delivery, forcesave-first ordering
      src/callback.ts       # state machine + persist + lock events
      src/ooxml.ts          # docx/xlsx text+comments parse, quote-level edits
      src/ping.ts           # comment diff -> wake queue (docs ping pattern)
      src/tools.ts          # office_* tools, lock/revision gates
      src/server.ts         # default export: routes wiring everything above
      web/client.ts         # nav.page, panel, tool cards, settings page
      web/office-editor.ts  # header + api.js/DocEditor mount
      style.css
      test/*.test.mts       # unit + docker-gated integration
      test/browser/office.spec.mts
      fixtures/sample.docx, sample.xlsx

No changes to core/*, no new root workspaces entry, no change to defaults.json.

## 9. Milestones

**M0 -- spikes (answer the unknowns; ~1-2 d)**
- Reachability: container -> loopback listener (ticket + callback) under
  sharedNetwork() in BOTH host mode and container mode; record the exact
  DS-side origin for document.url/callbackUrl and the browser-side DS origin;
  confirm a port-80 collision is surfaced clearly when starting.
- Browser reach to DS: three options -- (a) keep direct DS origin and declare
  editor access local-machine-only with documented exposure; (b) spike an
  in-container nginx override so DS actually listens on 127.0.0.1:<P> inside the
  container (fragile vs image drift); (c) portal reverse-proxy route for DS
  traffic (portal.http.raw + portal.http.upgrade, already login-checked) with
  the iframe on the portal origin -- remote users work, DS stays server-side,
  and same-origin unlocks the programmatic DocEditor surface of §5.7 (c is the
  preferred target; fall back to a/b only if the proxy spike fails). Pick one;
  this decides §6 OfficeEditor's src mechanism.
- Same-origin client API surface (assumes option c): does
  DocEditor.refreshFile(newConfig) called programmatically -- not in answer to
  onRequestRefreshFile -- update an open editor? do client-side config events
  (comment add, appstate) fire for us same-origin? does createConnector()
  (Automation API) expose a usable client-side surface on the live session?
  Result decides the §5.7 fidelity tier shipped in M2/M3.
- JWT configuration of the pinned image: confirm single JWT_SECRET env covers
  config + callbacks (expected from docs); only if a supported per-direction
  knob exists on that build consider the two-secret variant. Also pick the pin
  (not :latest), verify status semantics match §4, and capture the exact
  regulated signing set for the config token; measure idle RAM.
- Blank docx/xlsx template validity: open in real editor, save back cleanly.
Deliverable: spike notes appended to this file; plan amendments where needed.

**M1 -- human editor works**
Package skeleton + build; lifecycle (start/stop/status/settings page); library
store (index.json, docs/<docId>/, owner + grants, import/export to chat
folders); verify dataDir persistence/backup treatment; storage host routes;
**global Office tab** (library browser) + per-home panels; OfficeEditor iframe opens a document and edits it;
save round-trip lands the updated .docx in the library with bumped revision;
atomic persist verified. Acceptance: create -> open -> edit -> close -> file on
disk changed, lock released, status page clean.

**M2 -- agent tools**
office_list/create/read/edit (+ xlsx read), lock + revision gates, coded errors,
audit entries, tool cards in chat UI. Acceptance: unit tests green; agent edits
a docx and the change reaches the open editor via the refresh flow (§5.7,
key rotation works) or renders on next open when no session is live.

**M3 -- wake on mention**
comments.xml diff, **mention grammar** (@agent = owner / @<name> = agent /
@project:<name> = project), home-chat routing, grant creation + audit, ping
queue + per-home pi delivery, panel + background entries (docs pattern).
Acceptance: a human comments "@aegis ..." in an open doc -> after save/close
(or forcesave) Aegis's home fires the turn with the quoted comment AND gains a
visible, audited grant on that doc; bare @agent wakes the owning agent/project;
no double-wake on repeated callbacks.

**M4 -- polish & stretch**
Co-editing hardening (connector tier if the spike won; strict per-comment
grant expiry per D3), xlsx cell edits + xlsx comment wakes
(xl/commentsN.xml layout), office_comment_add (only
with strict validator), postMessage live lock badge, .pptx read, docs page in /docs, fresh-portal opt-in install
test, RAM warning UX. Done = issue #280 ready to close.

## 10. Risks / open items

- **DS build drift**: callback/jwt behavior changes across major versions --
  hence pinned tag + M0 verification + integration test.
- **OOXML edit fragility**: run-splitting in w:t is the classic corruption
  vector; mitigations: paragraph-level targeting, byte-preserving zip rewrite,
  fixture round-trip tests, refuse-on-surprise.
- **Resource floor**: ~4 GB RAM (issue-accepted trade-off); surfaced at enable
  time; status page shows container memory via inspect.
- **Container-endpoint plumbing**: the cookie-free endpoints sit on a
  standalone loopback listener BY DESIGN (verified: every /api/* route is behind
  session auth, so a portal router route would 401 for DS). Least certain part:
  the browser-reach decision (M0 spike 2) and port-80 behavior of shared
  networking in both deployment shapes.
- **Co-editing is a refresh model, not true co-editing** unless the
  connector spike lands. It is now the DEFAULT (user-confirmed), so the
  forcesave-first ordering against unsaved human changes is critical safety
  logic; a disable setting remains as escape hatch.
- **Mention name resolution**: agents/projects matched by display name
  (case-insensitive exact). Duplicate names -> no wake + log; enforcement or
  disambiguation is polish, not v1.
- **dataDir persistence/backup**: assumed to match chat-folder treatment; M1
  verifies, otherwise the library location or a docs note moves.
- **Spreadsheet wake**: xlsx stores comments differently (xl/commentsN.xml +
  VML anchors, not word/comments.xml) -- v1 docx-only; deferred, not a blocker.

## Appendix A -- verified references

- Callback handler reference: https://api.onlyoffice.com/docs/docs-api/usage-api/callback-handler/
  (fetched; status table + parameters + Node.js save example as summarized in §4)
- Config reference: https://api.onlyoffice.com/docs/docs-api/usage-api/config
  (documentType values, token field, embedded type)
- DocEditor embedding + regulated signing:
  https://api.onlyoffice.com/docs/docs-api/usage-api/doceditor/ and
  .../additional-api/signature/browser (fetched; api.js entry point,
  placeholder -> iframe replacement, signed parameter set incl.
  document.permissions / editorConfig.mode since 7.1)
- Client-side DocEditor methods (fetched):
  https://api.onlyoffice.com/docs/docs-api/usage-api/methods/ --
  refreshFile("updates the file version without reloading the editor",
  documented via onRequestRefreshFile), refreshHistory/setHistoryData (version
  history with changes + serverVersion), createConnector (Automation API),
  requestClose, denyEditingRights
- Docker deployment: helpcenter community-install +
  github.com/ONLYOFFICE/Docker-DocumentServer README (env vars only
  JWT_ENABLED/JWT_SECRET/JWT_HEADER/JWT_IN_BODY on the 10.x community image;
  local.json regenerated on restart; system requirements RAM >= 4 GB, DS on :80,
  no listen-address env; current tags 10.0/10.0.0)
- In-repo checks for the second/third revisions: portal.dataDir() exists
  (packages/extension-api/server.d.ts:844; understory store precedent);
  chat kind is "agent"|"project"|"chat" (server.d.ts:95) so per-agent/project
  ownership maps to the owner/grants index fields.
- In-repo checks done for the first revision (technical review): sharedNetwork() returns "host" or container:<id> (extensions/docker/src/docker.ts:33-44); a shared-netns container publishes no ports because Docker ignores PortBindings under host/container network modes (Docker semantics, not stated in the repo file); portal.files 1 MB cap
  (core/server/src/workspace-files.ts MAX_EDIT_BYTES); /api/* session-gated
  (core/server/src/server.ts requireAuth; extension-host mounts at /api/x after
  login); pithagoras.requires nesting (extension-host loader; understory
  package.json)
- docspace-mcp: https://github.com/ONLYOFFICE/docspace-mcp -- README verified:
  Docspace cloud SaaS target (DOCSPACE_BASE_URL / DOCSPACE_API_KEY), toolsets =
  rooms/folders/permissions/people; NOT an on-prem DS file-content MCP.
- In-repo precedents cited in §3 table (understory host/server, docker api.ts,
  docs client/tools/ping).
- xlsx comment parts (xl/commentsN.xml) per the OOXML/ECMA-376 spreadsheet
  packaging structure.
