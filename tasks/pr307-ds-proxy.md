# PR #307 — DS traffic proxied through the portal (remote-browser fix)

Branch `office/280-pithagoras-office`, base tip before change: `e5673b5d`. Scope: `extensions/office/**` only.
No docker commands were run against `pithagoras-office-ds`; no touch of `/var/lib/pithagoras` or the running portal (read-only recon only).

## The problem (live-verified before the change)

The user's browser is NOT on the server host, but `POST /editor-config` answered
`apiJs: http://127.0.0.1/web-apps/apps/api/documents/api.js` — an ABSOLUTE loopback URL built from the recorded
DS origin (`dsOrigin(dd)`), because the DS container runs with `NetworkMode=host` and nginx binds :80 on the host.
On-host that URL serves 200 (OnlyOffice nginx) — but a browser on another machine cannot dial it, so
`office-editor.tsx`'s `loadScript()` failed with *"the editor script at http://127.0.0.1/web-apps/... could not be loaded"*.

## Why a portal proxy works (empirically verified)

- **api.js is prefix-aware.** Its `getBasePath()` walks the document's `<script>` tags and returns
  `script.src.match(/(.*)api\/documents\/api.js/i)[1]` — everything BEFORE `api/documents/api.js` in the loaded
  script's src becomes the base of the editor iframe URL. So the SAME api.js loads identically from
  `…/ds/web-apps/apps/api/documents/api.js`, and the browser then builds the iframe from that same prefix.
- **createIframe(config)** sets `iframe.src = getAppPath(config) + getAppParameters(config)`; for our config
  (`type: "embedded"`) path = `getBasePath()`, and appMap word→documenteditor / cell→spreadsheeteditor gives
  `<prefix>/web-apps/apps/<app>/main/index.html?dockey=…` — still under the proxy prefix.
- **The editor pages are fully relative.** The live DS page `/web-apps/apps/documenteditor/main/index.html`
  references every asset relatively: `src '../../../vendor/requirejs/require.js'`,
  `src '../../common/main/lib/util/fix-ie-compat.js'`, `href 'resources/img/favicon.ico'`, etc. Because all of them
  resolve inside the same prefix, serving api.js + editor pages under `/api/x/pithagoras-office/ds/web-apps/…`
  keeps every reference inside that prefix — no path rewriting needed, just faithful byte forwarding.
- **The SIGNED config is untouched.** `buildEditorConfig` (server.ts ~249–287) puts ONLY loopback URLs in it:
  `document.url = http://127.0.0.1:<loopPort>/doc/<ticket>` and `editorConfig.callbackUrl = …/callback`. Those are
  fetched by the DS server-side (host netns → loopback works), never by a browser, so they stay exactly as-is —
  changing them would break signing semantics and DS behavior. `apiJs` is NOT part of the signed payload: the
  client drops it (`office-editor.tsx` ~lines 76–77: `delete config.apiJs`) before calling DocEditor, and the JWT
  is computed over the plain config only (asserted in `test/server.test.mts`, "editor-config (docx)" test).

## What changed

1. **Proxy route** — `src/server.ts` `registerRoutes`: new catch-all `r.get(/^\/ds\/(.*)$/, handler)` on the same
   router core mounts at `/api/x/pithagoras-office` behind the session gate (`core/server/src/extension-host.ts:1043`,
   `app.use("/api/x", extensionRoutes)` in `core/server/src/server.ts:1711`). Handler:
   - recomputes the upstream path from the RAW `req.url` after the first `/ds/`, query string included verbatim
     (express params may be decoded; an iframe's `?dockey=…` must not be);
   - `origin = dsOrigin(dd)` — empty → 503 `{code:'ds_not_configured'}`; `container:` prefix → 422 in the same JSON
     family as the existing `/editor-config` refusal (`{code:'unresolvable_ds_origin', origin}`);
   - `fetch(origin + '/' + rest, { redirect: 'follow', signal: AbortSignal.timeout(15000) })`; network error → 503
     `{code:'ds_unavailable'}` + `logLine` (Node 23 global fetch);
   - answers the upstream status; copies only `content-type`, `content-encoding`, `content-length`, `cache-control`,
     `content-disposition`, `access-control-allow-origin` when present; body buffered via `upstream.arrayBuffer()`
     and passed through UNTOUCHED (Node fetch does not decompress, so a gzip/br body plus its `content-encoding`
     reach the browser as-is — no corruption); everything else dropped. GET-only, no state mutation.
2. **editor-config** — `apiJs` is now root-relative: `` `/api/x/${encodeURIComponent(portal().extension)}/ds/web-apps/apps/api/documents/api.js` ``
   (`portal().extension` = package name `pithagoras-office`). The browser resolves it against the page origin —
   exactly where the user reached the portal; `getBasePath()` captures that whole prefix. Everything else in the
   answer (config fields, token) is unchanged.
3. **Docs** — server.ts header block: browser reaches DS via the `/ds` proxy while `document.url`/`callbackUrl`
   stay loopback for DS-side fetches. README: "a portal proxy for DS traffic" removed from Deferred; the M0
   browser-reach bullet now records that it resolved to the same-origin proxy; one new Security-notes bullet on the
   gate + single-destination forwarding. The 422 for `container:` origins stays documented.

## Tests (new, in `test/server.test.mts`; harness extended minimally)

`MiniRouter` now also accepts RegExp patterns (express regex routes match the whole raw url incl. query; groups →
`params[0..]`), and the fake portal in `boot()` carries `extension: "pithagoras-office"`. The existing apiJs
assertion was updated from the absolute loopback URL to the new root-relative proxy URL (the test still asserts
the signed config's document.url/callbackUrl are loopback). New fake-DS helper (`http.createServer` on an ephemeral
127.0.0.1 port, mirroring the `dsStandin` pattern in `test/integration.test.mts` ~line 175) with a seeded
`ds.json` pointing at it; asserts:
- **200 pass-through**: body byte-for-byte, `content-type`/`cache-control` copied, and the RAW query string
  (`?dockey=a%2Bb~c&lang=en-US&x=1%20two`) arrived upstream unmodified (verified against the fake DS's recorded
  `req.url` — no re-encoding);
- **upstream 404 passes through as 404** with the upstream body;
- **dead port → 503 `{code:'ds_unavailable'}`** + a log line left behind;
- **no ds.json → 503 `ds_not_configured`**, and **`container:` origin → 422 `unresolvable_ds_origin`** (same family as `/editor-config`).

## Verification

- `env -u NODE_ENV node --import tsx --test test/*.test.mts`, run three times: **150 tests / 147 pass / 0 fail / 3
  skipped** (the 3 docker-gated integration tests; baseline before this change was 146/143/3).
- `npx tsc --noEmit -p extensions/office` → exit 0.
- `node scripts/build-extensions.mjs` → exit 0 (refreshes the gitignored built outputs the running portal loads
  from: `server.js`, `web/`).
