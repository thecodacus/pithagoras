# @pithagoras/extension-api

What a [Pithagoras](https://github.com/thecodacus/pithagoras) extension is given, as types, and the build that bundles
one written in TypeScript and JSX.

- `@pithagoras/extension-api`: `Portal`, what a browser half's default export is called with, and the slots' entries
  and props.
- `@pithagoras/extension-api/server`: `ServerPortal`, what a server half's default export is called with.
- `@pithagoras/extension-api/build`: `buildExtension({ dir })` bundles `src/client.tsx` into `web/client.js` and
  `web/client.css`, with React taken from the portal.

The portal implements exactly these types and is checked against them when it is built. The guide is
[Building an extension](https://thecodacus.github.io/pithagoras/guide/extension-ui).
