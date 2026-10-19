# @pithagoras/extension-api

What a [Pithagoras](https://github.com/thecodacus/pithagoras) extension is given, as types, the build that bundles
one written in TypeScript and JSX, and a portal to test one against.

- `@pithagoras/extension-api`: `Portal`, what a browser half's default export is called with, and the slots' entries
  and props.
- `@pithagoras/extension-api/server`: `ServerPortal`, what a server half's default export is called with.
- `@pithagoras/extension-api/build`: `buildExtension({ dir })` bundles `src/client.tsx` into `web/client.js` and
  `web/client.css`, with React taken from the portal. `install: true` installs the extension's own packages first.
- `@pithagoras/extension-api/testing`: `mockPortal()`, a portal to call a server half with in a test: chats and their
  folders, a chat's pi, the portal's own `files` and the pages that listen to `push`, without importing any of the
  portal's own code into the test. It stands on the portal's source in a checkout of it (run under tsx, or built), so it is
  for the extensions that live in the portal's repository; with the package from npm there is no portal beside it.
The portal implements exactly these types and is checked against them when it is built. The guide is
[Building an extension](https://thecodacus.github.io/pithagoras/guide/extension-ui).
