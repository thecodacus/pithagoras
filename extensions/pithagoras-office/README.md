# pithagoras-office

Office documents (.docx and .xlsx) edited in a real [OnlyOffice Document Server](https://github.com/ONLYOFFICE/Docker-DocumentServer) container that the portal runs of its own. The plan of record is `PLAN-office-280.md` (issue #280); this note says what ships in v1 and where everything lives.

## What it is

An opt-in package (it requires `pithagoras-docker`). In plain terms, v1 gives you:

- **A document library** on the portal's Office tab: create blank Word/sheet documents, open them full-screen in the embedded OnlyOffice editor, import/export .docx/.xlsx to chat folders, delete (7-day trash).
- **Agent tools** (`office_list`, `office_create`, `office_read`, `office_edit`, `office_comments`) registered in agent/project home chats. Agents read and edit the SAME files humans edit; writes are quote-based replacements gated on a revision number (the file's mtime), so a stale agent edit fails loudly instead of clobbering a human save.
- **Co-editing default ON**: an open editor session does not block an agent edit — the extension force-saves the session first and re-checks the revision; a disable toggle in settings is the escape hatch. Every agent revision is recorded for the editor's version history.
- **Wake on mention**: when a human comments `@agent` (the doc's owner) or `@<name>` / `@project:<name>` (a named agent/project) and saves, that home chat gets pinged with the quoted comment and gains an audited grant on the document.

## Requirements

- Docker on the host the portal runs from (shared networking: the DS container joins the same netns as the portal).
- **~4 GB of RAM** for the Document Server container — the settings page warns before first start, and the status block shows live memory usage once it runs.

## Setup

1. Install/enable the package, then open Settings → office: enable it and press start. The pinned image (default `onlyoffice/documentserver:10.0` — never `:latest`; changing the tag can silently change callback/JWT behavior) is pulled on first start with progress shown in the UI.
2. Documents appear under the Office tab. Open one to edit; agents work on it through their chat tools.

## Where things live, and what is exposed

All state is inside the extension's own data directory (`portal().dataDir()`): `settings.json`, `jwt-secret` (0600, created once), `ds.json` (container id + recorded origin), `index.json` + `docs/<docId>/<title>.<ext>` (the library), `.trash/`, `state/<docId>.json` (last-seen comment ids), and `history/<docId>/<rev>.zip` (change snapshots for the editor's version history).

The DS container itself holds no session cookie, while every portal route is login-gated — so the two endpoints the container needs (a ticketed document GET and the callback POST) live on a **standalone loopback listener bound to 127.0.0.1 only**, on an ephemeral port minted per boot: `GET /doc/<ticket>` (HMAC + 10-minute expiry, no user context) and `POST /callback` (HS256-verified). Nothing else listens on it, and nothing outside the container's own network can reach it. The DS web origin (:80 of the shared netns) is a separate exposure question — see below.

## Deferred (honest list)

From the plan, intentionally NOT in v1:

- **xlsx comments** (`xl/commentsN.xml` + VML layout) — reading and wakes for spreadsheet comments are M4; Word comments work now.
- **Co-editing refresh handshake / M0 browser-reach decision**: whether `DocEditor.refreshFile()` can be pushed programmatically, and how browsers reach the DS origin (direct local-only vs in-container nginx override vs a portal reverse-proxy route) were M0 spikes; v1 ships with the recorded-origin (option a) behavior and a "agent updated — refresh" badge fallback. The proxy option would make the editor surface same-origin and is the preferred target later.
- **A portal proxy for DS traffic** (the option-c above) — deliberately unimplemented until the spike outcome is re-verified on a pinned build.
- `.pptx` reading, `office_comment_add`, per-comment grant expiry, postMessage live lock badges — M4 stretch items.
