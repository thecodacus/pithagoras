# pithagoras-office

Office documents (.docx and .xlsx) edited in a real [OnlyOffice Document Server](https://github.com/ONLYOFFICE/Docker-DocumentServer) container that the portal runs of its own. The plan of record is `PLAN-office-280.md` (issue #280); this note says what ships in v1 and where everything lives.

## What it is

An opt-in package (it requires `pithagoras-docker`). In plain terms, v1 gives you:

- **A document library** on the portal's Office tab: create blank Word/sheet documents, open them full-screen in the embedded OnlyOffice editor, sort the list by name / modified / size / type, and export (download) a copy of one. There is no manual import: every `.docx`/`.xlsx` found across the agent homes and projects (`portal().folders.list()`) is indexed **automatically at boot** (and on demand with the **Rescan workspace** button) — IN PLACE, so the scanned file IS the document and is edited through the same mtime-gated flow. Deleting a workspace-scanned document moves its real file into this library's trash, like everything else: reversible for 7 days.
- **Agent tools** (`office_list`, `office_create`, `office_read`, `office_edit`, `office_comments`) registered in agent/project home chats. Agents read and edit the SAME files humans edit; writes are quote-based replacements gated on a revision number (the file's mtime), so a stale agent edit fails loudly instead of clobbering a human save.
- **Co-editor model (no switch)**: the agent is just another user in the editor, like Office 365 — a human and the agent may edit the same document at the same time, and there is no setting to turn that on or off. Agent edits always proceed under the strict mtime/revision gate; if the file changed since they were read (for example a co-editor's save), NOTHING is written and the tool answers a loud `error:revision_mismatch` CONFLICT naming the open editor session when one stands — re-read and retry. Conflicts are surfaced, not prevented by refusal. Open editors learn about external changes through the existing 5 s polling loop (`live.ts pollState`). Every agent revision is recorded for the editor's version history.
- **Wake on mention**: when a human comments `@agent` (the doc's owner) or `@<name>` / `@project:<name>` (a named agent/project) and saves, that home chat gets pinged with the quoted comment and gains an audited grant on the document.

## Requirements

- Docker on the host the portal runs from (shared networking: the DS container joins the same netns as the portal).
- **~4 GB of RAM** for the Document Server container — the settings page warns before first start, and the status block shows live memory usage once it runs.

## Setup

1. Install/enable the package, then open Settings → office: enable it and press start. The pinned image (default `onlyoffice/documentserver:10.0` — never `:latest`; changing the tag can silently change callback/JWT behavior) is pulled on first start with progress shown in the UI.
2. Documents appear under the Office tab: what you create here, plus every `.docx`/`.xlsx` found across the agent homes and projects — indexed automatically at boot (the scan runs after `settleKept`, so files that vanished while the portal slept are pruned, not re-added), with Rescan picking up anything written straight to disk afterwards. Open one to edit; agents work on it through their chat tools.

## Where things live, and what is exposed

All state is inside the extension's own data directory (`portal().dataDir()`): `settings.json`, `jwt-secret` (0600, created once), `ds.json` (container id + recorded origin), `index.json` + `docs/<docId>/<title>.<ext>` (the library), `.trash/`, `state/<docId>.json` (last-seen comment ids), and `history/<docId>/<rev>.zip` (change snapshots for the editor's version history).

The DS container itself holds no session cookie, while every portal route is login-gated — so the two endpoints the container needs (a ticketed document GET and the callback POST) live on a **standalone loopback listener bound to 127.0.0.1 only**, on an ephemeral port minted per boot: `GET /doc/<ticket>` (HMAC + 10-minute expiry, no user context) and `POST /callback` (HS256-verified). Nothing else listens on it, and nothing outside the container's own network can reach it. The browser-facing half of the DS goes the other way: a **portal reverse proxy** (`GET /ds/<rest…>` under this extension's session-gated routes) forwards the editor traffic — api.js, the editor iframe, every asset — to the recorded DS origin, so remote browsers reach the editor through exactly the same URL prefix they use for the portal. That is why `document.url` and `editorConfig.callbackUrl` can stay absolute loopback URLs in the signed config: only the DS server itself fetches them.

## Deferred (honest list)

From the plan, intentionally NOT in v1:

- **xlsx comments** (`xl/commentsN.xml` + VML layout) — reading and wakes for spreadsheet comments are M4; Word comments work now.
- **Co-editing refresh handshake**: whether `DocEditor.refreshFile()` can be pushed programmatically was an M0 spike; v1 ships with the "agent updated — refresh" badge fallback. The M0 browser-reach question resolved to the portal reverse-proxy route (`/ds`, see Security notes) — the editor surface is same-origin.
- `.pptx` reading, `office_comment_add`, per-comment grant expiry, postMessage live lock badges — M4 stretch items.
- **Exporting into chat folders** — the export route serves a download of the stored bytes (fresh copy, served as an attachment); copying a document into a chat folder does not exist in v1.

## Security notes

- **The `/ds` proxy stays behind the session gate.** Browser editor traffic (api.js, iframe, assets) reaches the DS only through `GET /api/x/<extension>/ds/…`, mounted like every other route of this extension behind the portal's login — and it forwards to exactly one origin: the recorded DS origin in `ds.json` (`"container:<id>"` markers refuse with 422, an unreachable origin with 503). GET-only, no body, single destination.
- **Host networking exposes the Document Server on every interface.** The DS container runs with the portal's shared network (`NetworkMode` from `docker.sharedNetwork()`; this deployment resolves it to `"host"`), so the image's own nginx serves the DS web origin (:80) on 0.0.0.0 — anything that can reach that machine's port 80 (the local host, the LAN, a tailnet peer) reaches the Document Server UI and API without going through any portal login gate: v1 has no authentication in front of that origin (the per-config JWTs sign requests the PORTAL mints; they are not an access-control layer for strangers). Operators should firewall :80 accordingly (e.g. reachable from the machine itself only), or override `/etc/nginx/conf.d` via a named volume to bind nginx to loopback — planned work, not something v1 does.
