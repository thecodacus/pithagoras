// Development-only: a test page of an extension's own, kept with its tests (extensions/<folder>/test/browser/<page>.page.tsx)
// and served by the portal's dev server: /tests/extension.html?page=<folder>/<page>, and whatever else the page reads.
const pages = import.meta.glob('../../../extensions/*/test/browser/*.page.tsx');
const asked = new URLSearchParams(location.search).get('page') ?? '';
const load = pages[`../../../extensions/${asked.replace('/', '/test/browser/')}.page.tsx`];
if (!load) throw new Error(`There is no test page "${asked}": an extension's are extensions/<folder>/test/browser/<page>.page.tsx`);
void load();
