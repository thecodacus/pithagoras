import { registerHooks, type ResolveHookSync } from "node:module";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * A server half's first revision is loaded as Node loads any module, and each revision after it whole, under its own.
 *
 * The portal imports a half's module from the address moduleAt gives (see start in extension-host.ts). Node keeps every
 * module it has loaded by its address, so the same file changed is another module only under another address. The
 * first revision of a module the process starts is at the file's own address, and so is all it imports: the modules
 * any other import of those files in the process gets, a test's or a pi extension's (pi leaves a `.js` file of an ESM
 * package to Node). A revision after it, of a half installed again after a file of its folder changed (the folder of
 * its module, and those below it: the files its revision covers, see revOf in extension-ui.ts), is at
 * `<file>?pithagoras-rev=<rev>`. What that module imports is another address of its own, and without the revision Node
 * would give it the files the first revision imported. So an import made by a module whose address carries the
 * revision, of a file in the half's folder, carries the same revision: the new revision evaluates all of its files
 * again, as modules of its own, and what else imported them keeps the first revision's.
 *
 * Only a relative address (`./`, `../`) or a `file:` URL: what a half imports by a bare name (a dependency in its
 * `node_modules`, `node:fs`) is the module Node already has. Nor a CommonJS file (a `.cjs` file, a `.js` file where the
 * package is not `"type": "module"`, or anything loaded with `require()`), imported or required: Node keeps those by
 * their file, whatever the address. Nothing else in the process is touched: no other module's address carries the
 * parameter.
 */
export const REVISION = "pithagoras-rev";

/** The revision each module was first started at, by its file: the one at the file's own address. */
const firsts = new Map<string, string>();

/** The folders of the server halves started at a revision after their first, as `file:` URLs ending in a slash. */
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
 * Where to import a server half's module from at revision `rev`; `file` is its real path. At the file's own address for
 * the first revision of it the process starts, and for that revision again; under `rev` for any other, the files of its
 * folder it imports too, for which the hook is put in place the first time.
 */
export function moduleAt(file: string, rev: string): string {
  const address = pathToFileURL(file);
  if (!firsts.has(file)) firsts.set(file, rev);
  if (firsts.get(file) === rev) return address.href;
  folders.add(`${pathToFileURL(dirname(file)).href}/`);
  if (!hooked) {
    hooked = true;
    registerHooks({ resolve });
  }
  address.searchParams.set(REVISION, rev);
  return address.href;
}
