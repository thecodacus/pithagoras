import { registerHooks, type ResolveHookSync } from "node:module";
import { pathToFileURL } from "node:url";

/**
 * Every file of a server half is loaded under its revision, not only its module.
 *
 * The portal imports a half's module as `<file>?pithagoras-rev=<rev>` (see start in extension-host.ts): Node keeps every
 * module it has loaded by its address, so the same file changed is another module only under another address. What
 * that module imports is another address of its own, and without the revision Node would give a new revision of the
 * half the files its first one imported. So an import made by a module whose address carries the revision, of a file
 * in the half's folder (the folder of its module, and those below it: the files its revision covers, see revOf in
 * extension-ui.ts), carries the same revision, and a new revision of the half evaluates all of its files again.
 *
 * Only a relative address (`./`, `../`) or a `file:` URL: what a half imports by a bare name (a dependency in its
 * `node_modules`, `node:fs`) is the module Node already has. Nor a CommonJS file (a `.cjs` file, a `.js` file where the
 * package is not `"type": "module"`, or anything loaded with `require()`), imported or required: Node keeps those by
 * their file, whatever the address. Nothing else in the process is touched: no other module's address carries the
 * parameter.
 */
export const REVISION = "pithagoras-rev";

/** The folders of the server halves started, as `file:` URLs ending in a slash. */
const folders = new Set<string>();

/**
 * The hook that gives an import the revision of the module that makes it, where both are in one half's folder. Node
 * calls it for every module the process resolves, the portal's own included: one imported by a module whose address
 * carries no revision is passed on as Node resolved it, after a look at that address.
 */
const resolve: ResolveHookSync = (specifier, context, next) => {
  const resolved = next(specifier, context);
  const parent = context.parentURL;
  if (!parent?.includes(`${REVISION}=`) || !/^(?:\.\.?\/|file:)/.test(specifier)) return resolved;
  const rev = new URL(parent).searchParams.get(REVISION);
  if (rev === null || ![...folders].some((folder) => parent.startsWith(folder) && resolved.url.startsWith(folder))) return resolved;
  const url = new URL(resolved.url);
  url.searchParams.set(REVISION, rev);
  return { ...resolved, url: url.href };
};

let hooked = false;

/**
 * The files of `folder`, where a server half's module is, its real path, are loaded under the revision of the module of
 * that folder that imports them. Called before the module is imported; the hook is put in place the first time.
 */
export function underRevision(folder: string): void {
  folders.add(`${pathToFileURL(folder).href}/`);
  if (hooked) return;
  hooked = true;
  registerHooks({ resolve });
}
