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
 * With `tailwind: true`, the Tailwind utilities its code uses are made into
 * its stylesheet, after what it imports, with the portal's colours, rounding
 * and shadow (./tailwind.mjs) and without Tailwind's reset: the portal's page
 * has had its own since before any extension came. They are scoped to the
 * extension's own parts, which the portal draws inside an element marked with
 * its package's name: the portal's utilities go by the same names, and one of
 * the extension's that came after them would win over the portal's own
 * (a `.flex` over an `md:hidden`) everywhere on the page. With `server`, its server
 * half is written in TypeScript too: that module is bundled into `server.js`
 * beside its package.json, its packages left to be imported where it runs.
 *
 * esbuild is the caller's, and tailwindcss and postcss with `tailwind`: they
 * are peers of this package.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import portal from "./tailwind.mjs";

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
 * them each time; anything else there is left as it is. `tailwind`: make the
 * utilities its code uses into `client.css`. `server`: the server half's
 * module (`src/server.ts`), built into `server.js` in `dir`.
 */
export async function buildExtension({ dir, entry = "src/client.tsx", outdir = "web", minify = true, tailwind = false, server } = {}) {
  if (!dir) throw new Error("buildExtension needs the extension's folder: { dir }");
  const { build } = await import("esbuild");
  const out = path.resolve(dir, outdir);
  for (const owned of ["chunks", "assets"]) rmSync(path.join(out, owned), { recursive: true, force: true });
  const client = await build({
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
  if (tailwind) await utilities(dir, path.join(out, "client.css"), minify);
  if (server) {
    await build({
      entryPoints: [path.resolve(dir, server)],
      outfile: path.join(dir, "server.js"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      // Its packages are imported where it runs, from its own node_modules: a native one cannot be bundled.
      packages: "external",
      legalComments: "eof",
      logLevel: "warning",
    });
  }
  return client;
}

/**
 * The Tailwind utilities the extension's code names, with the portal's preset,
 * after what is already in `css` (its own stylesheet, if it imports one), each
 * for the extension's own parts only. Only utilities: Tailwind's reset would
 * restyle the whole page.
 */
async function utilities(dir, css, minify) {
  const { default: postcss } = await import("postcss");
  const { default: tailwindcss } = await import("tailwindcss");
  const { name } = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  const made = await postcss([
    tailwindcss({
      presets: [portal],
      // `:where` keeps each utility's weight as the portal's is: inside the extension's parts, the later one wins.
      important: `:where([data-extension=${JSON.stringify(name)}])`,
      content: [path.join(dir, "src/**/*.{ts,tsx,js,jsx}")],
      corePlugins: { preflight: false },
    }),
  ]).process("@tailwind utilities;", { from: undefined });
  let text = made.css;
  if (minify) text = (await (await import("esbuild")).transform(text, { loader: "css", minify: true })).code;
  const own = existsSync(css) ? readFileSync(css, "utf8") : "";
  writeFileSync(css, own ? `${own}\n${text}` : text);
}
