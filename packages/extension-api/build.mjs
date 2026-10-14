/**
 * Bundles an extension's browser half written in TypeScript and JSX into the
 * module the portal loads: `web/client.js`, with the stylesheet its code
 * imports beside it (`web/client.css`) and what it loads later with
 * `import()` as chunks of their own, fetched only when asked for.
 *
 * The bundle carries no React of its own. `react`, `react/jsx-runtime` and
 * `react-dom` are the portal's, which it hands to every extension before the
 * extension's module is loaded: a component drawn in one of the portal's slots
 * has to be made with the portal's React for its hooks to work. Any other
 * package the code imports is bundled into it.
 *
 *   // build.mjs, in the extension's folder
 *   import { buildExtension } from "@pithagoras/extension-api/build";
 *   await buildExtension({ dir: import.meta.dirname });
 *
 * esbuild is the caller's: it is a peer of this package.
 */
import { rmSync } from "node:fs";
import path from "node:path";

/** The portal's packages, by what the code imports, and the names each hands out. */
const SHARED = {
  react: {
    from: "React",
    names: [
      "Children", "Component", "Fragment", "Profiler", "PureComponent", "StrictMode", "Suspense", "cloneElement", "createContext",
      "createElement", "createRef", "forwardRef", "isValidElement", "lazy", "memo", "startTransition", "useCallback", "useContext",
      "useDebugValue", "useDeferredValue", "useEffect", "useId", "useImperativeHandle", "useInsertionEffect", "useLayoutEffect", "useMemo",
      "useReducer", "useRef", "useState", "useSyncExternalStore", "useTransition", "version",
    ],
  },
  "react/jsx-runtime": { from: "jsxRuntime", names: ["Fragment", "jsx", "jsxs"] },
  "react-dom": { from: "ReactDOM", names: ["createPortal", "flushSync"] },
};

/** Resolves the portal's packages to what the portal handed over, in place of a copy of their own. */
const portalPackages = {
  name: "pithagoras-portal-packages",
  setup(build) {
    build.onResolve({ filter: /^(react|react-dom|react\/jsx-runtime)$/ }, (args) => ({ path: args.path, namespace: "pithagoras-portal" }));
    build.onLoad({ filter: /.*/, namespace: "pithagoras-portal" }, (args) => {
      const { from, names } = SHARED[args.path];
      return {
        loader: "js",
        contents: [
          `const given = globalThis.__pithagoras && globalThis.__pithagoras.${from};`,
          `if (!given) throw new Error("This module is a Pithagoras extension's, and is loaded by the portal: ${args.path} is the portal's own.");`,
          "export default given;",
          `export const { ${names.join(", ")} } = given;`,
        ].join("\n"),
      };
    });
  },
};

/**
 * Builds the browser half of the extension in `dir`.
 *
 * `entry` is its module (default `src/client.tsx`), and `outdir` the folder
 * its package.json names under `pithagoras.client` (default `web`). The build
 * owns `client.js`, `client.css`, `chunks/` and `assets/` in it, and replaces
 * them each time; anything else there is left as it is.
 */
export async function buildExtension({ dir, entry = "src/client.tsx", outdir = "web", minify = true } = {}) {
  if (!dir) throw new Error("buildExtension needs the extension's folder: { dir }");
  const { build } = await import("esbuild");
  const out = path.resolve(dir, outdir);
  for (const owned of ["chunks", "assets"]) rmSync(path.join(out, owned), { recursive: true, force: true });
  return build({
    entryPoints: { client: path.resolve(dir, entry) },
    outdir: out,
    bundle: true,
    format: "esm",
    splitting: true,
    target: "es2022",
    jsx: "automatic",
    minify,
    chunkNames: "chunks/[name]-[hash]",
    assetNames: "assets/[name]-[hash]",
    loader: { ".svg": "file", ".png": "file", ".jpg": "file", ".webp": "file", ".woff": "file", ".woff2": "file", ".ttf": "file" },
    legalComments: "eof",
    logLevel: "warning",
    plugins: [portalPackages],
  });
}
