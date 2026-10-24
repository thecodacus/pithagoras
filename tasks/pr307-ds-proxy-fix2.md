# PR #307 — follow-up fix: DS proxy identity encoding + honest Content-Length

Branch `office/280-pithagoras-office` (pushed tip before this change: `bfb5edc5`). Scope: `extensions/office/**` only.
No docker commands; no writes under `/var/lib/pithagoras`.

## The bug (empirically proven against the live stack)

The `GET /ds/<rest>` reverse proxy (`extensions/office/src/server.ts`, route formerly around lines 529–567) used
global `fetch` to forward to the DS origin and copied upstream headers — including `content-encoding` and
`content-length` — verbatim.

Node's undici `fetch` **auto-decodes gzip bodies but leaves the upstream `content-encoding: gzip` header and the
COMPRESSED `content-length` in place**. Verified live on the running stack:

```
GET http://127.0.0.1/web-apps/apps/api/documents/api.js   (default accept-encoding)
  -> content-encoding: gzip, content-length: 13720, arrayBuffer(): 67458 bytes
(identity request): content-encoding null, content-length: 67458
```

The handler copied both lying headers, then `res.end(<67458-byte buffer>)` → Node emitted
`Content-Length: 13720` for a 67458-byte payload. Browsers read the first 13.7 KB of api.js (invalid JS) and the
keep-alive stream was corrupted/reset — hence *"the editor script at /api/x/pithagoras-office/ds/web-apps/apps/
api/documents/api.js could not be loaded"* in every remote browser. Reproduced end-to-end: with a valid portal
session cookie, `GET /api/x/pithagoras-office/state` → 200 while both `/ds/` URLs died mid-transfer.

## The fix (extensions/office/src/server.ts)

1. **Ask for an unencoded body** — the fetch in this route only now passes `headers: { "accept-encoding": "identity" }`
   (upstream OnlyOffice nginx honours it, verified). Upstream then sends plain bytes with a truthful length.
2. **Never copy lying size/encoding headers** — removed `content-encoding` and `content-length` from the header-copy
   list (kept: `content-type`, `cache-control`, `content-disposition`, `access-control-allow-origin`). The body is fully
   buffered (`arrayBuffer` → `Buffer`), so Node computes Content-Length from the ACTUAL bytes. A route comment now
   records WHY (undici decodes gzip but keeps compressed lengths; we ask identity and size the answer ourselves, so
   header and payload are exactly consistent).
3. No other routes touched; refusal paths (`ds_not_configured` / `unresolvable_ds_origin` / `ds_unavailable`) unchanged.

## Tests (extensions/office/test/server.test.mts)

- The four existing proxy tests (pass-through of body/content-type/raw query, upstream 404, dead origin → 503
  `ds_unavailable`, unconfigured/container refusal) were reviewed: **none asserted content-encoding pass-through**,
  so no assertion changes were needed.
- **New regression test** — `/ds proxy: an identity request answered with GZIP bytes + LYING headers still delivers
  the FULL original payload`: a fake DS on ephemeral 127.0.0.1 that answers our `accept-encoding: identity` ask with
  a gzip-compressed body plus lying `content-encoding: gzip` / `content-length: <compressed byte count>`. Asserts:
  200, upstream was actually asked `identity`, content-type passes through, NEITHER lying header is copied onto the
  proxied answer, and the full original payload arrives byte-for-byte (undici decoded it — no truncation at the
  lying length, no manual gunzip).

## Finish line

- `env -u NODE_ENV node --import tsx --test extensions/office/test/*.test.mts` ×3 → 0 fail (baseline was 150 total /
  147 pass / 3 docker-gated skips; this change adds one test) — see results below.
- `npx tsc --noEmit -p extensions/office` → exit 0.
- `node scripts/build-extensions.mjs` → exit 0.
