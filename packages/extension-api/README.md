# @pithagoras/extension-api

What a [Pithagoras](https://github.com/thecodacus/pithagoras) extension is given, as types, and the build that bundles
one written in TypeScript and JSX.

- `@pithagoras/extension-api`: `Portal`, what a browser half's default export is called with, and the slots' entries
  and props.
- `@pithagoras/extension-api/server`: `ServerPortal`, what a server half's default export is called with, and
  `SubagentProtocol`, the channels a pi extension speaks on a chat's event bus to have its own agent shown and steered
  beside the chat.
- `@pithagoras/extension-api/build`: `buildExtension({ dir })` bundles `src/client.tsx` into `web/client.js` and
  `web/client.css`, with React taken from the portal, and with `server` the server half into `server.js`.
- `@pithagoras/extension-api/tailwind`: the portal's colours, rounding and shadow as a Tailwind preset.

The portal implements exactly these types and is checked against them when it is built. The guide is
[Building an extension](https://thecodacus.github.io/pithagoras/guide/extension-ui).

## An extension in its own repository

```
pithagoras-hello/
├── package.json
├── tsconfig.json
├── build.mjs
└── src/
    ├── client.tsx
    └── server.ts
```

```json
{
  "name": "pithagoras-hello",
  "version": "0.1.0",
  "type": "module",
  "keywords": ["pi-package"],
  "pi": {},
  "pithagoras": { "client": "./web/client.js", "style": "./web/client.css", "server": "./server.js" },
  "files": ["web", "server.js"],
  "scripts": { "build": "tsc --noEmit && node build.mjs", "prepack": "npm run build" }
}
```

- `keywords`: Settings → Extensions → **Find packages** lists packages with `pi-package`.
- `pi`: what the package brings pi (extensions, skills, prompts, themes). A Pithagoras extension is a pi package, so
  the key is there even when it brings pi nothing.
- `pithagoras`: its browser half, its stylesheet and its server half, as the build makes them.
- `pithagoras.isolated`: `true` runs the server half in a process of its own: see
  [A server half in a process of its own](https://thecodacus.github.io/pithagoras/guide/extension-ui#a-server-half-in-a-process-of-its-own).
- `files` and `prepack`: what is published is built first, and is only what the build made.

Run in the extension's folder, this adds what it is built with to its `package.json` as `devDependencies`:

```sh
npm install --save-dev @pithagoras/extension-api esbuild typescript tailwindcss@3 postcss @types/react@18 @types/node @types/express@5
```

`tailwindcss` and `postcss` are for `tailwind: true`, as the build below uses; leave them out for a build without
it. Code that imports `react-dom` needs `@types/react-dom@18` as well. They are peers of this package: it uses the
versions the extension installs.

```js
// build.mjs
import { buildExtension } from "@pithagoras/extension-api/build";

await buildExtension({ dir: import.meta.dirname, tailwind: true, server: "src/server.ts" });
```

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    // A stylesheet the code imports is the build's to bundle, and has no types.
    "noUncheckedSideEffectImports": false
  },
  "include": ["src"]
}
```

```tsx
// src/client.tsx
import { useEffect, useState } from "react";
import type { Portal } from "@pithagoras/extension-api";

export default function (portal: Portal) {
  function Hello() {
    const [text, setText] = useState("");
    useEffect(() => {
      portal.api.json<{ text: string }>(portal.api.url("/hello")).then((answer) => setText(answer.text));
    }, []);
    return <p className="m-3 rounded-xl bg-surface p-3 text-fg-muted">{text}</p>;
  }
  portal.slots.register("chat.panel", { id: "hello", title: "Hello", component: Hello });
}
```

```ts
// src/server.ts
import type { ServerPortal } from "@pithagoras/extension-api/server";

export default function (portal: ServerPortal) {
  portal.router.get("/hello", (_req, res) => {
    res.json({ text: `Hello from ${portal.extension}` });
  });
}
```

`npm run build` makes `web/client.js`, `web/client.css` and `server.js`. Installed, the extension puts a **Hello**
button in each chat's header, and its panel shows what the server half answered.

## Installing it in Pithagoras

In Settings → Extensions → Discover → **Install by name**:

| From | Spec | What has to be there |
| --- | --- | --- |
| npm | `npm:pithagoras-hello` | The package, published built: `npm publish` runs `prepack` |
| git | `git:github.com/you/pithagoras-hello@v1`, or `https://github.com/you/pithagoras-hello` | The built files, committed: pi installs the repository's `dependencies`, not its `devDependencies`, and does not build it |
| A folder on the server | `/path/to/pithagoras-hello` | The folder, built |

## Versions

This package is released with Pithagoras and has its version: 0.2.0 is what Pithagoras 0.2.0 gives an extension.
Pithagoras stays on 0.x while this interface still changes, and a 0.x minor version may break an extension, so an
extension depends on `"^0.2.0"`, which takes 0.2.1 and not 0.3.0.

`version` on `Portal` and `ServerPortal`, `1`, is not this package's version: it is the version of the interface the
portal loads an extension with, raised only when something an extension relies on changes.
