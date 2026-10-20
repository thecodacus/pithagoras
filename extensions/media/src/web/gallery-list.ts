/**
 * What the gallery of the Media page works out of the lists it holds, pictures or videos:
 * how a page that was asked for again joins the ones already there. Each item has an `id` and a `createdAt`, and
 * the lists are newest first, by id among those made in the same moment, as the portal orders them.
 */
interface Item {
  id: string;
  createdAt: number;
}

/** Whether `a` comes before `b` in the gallery's order: newest first, and by id among those made in the same moment, as the server orders them. */
const before = (a: Item, b: Item): boolean => a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id);

/**
 * The items there are, once the top of the list has been asked for again — one was made, or taken away, since: the
 * fresh page takes the place of the head of what is shown, and what was loaded further down stays. A list that
 * fits in the fresh page is that page. An item that is as it was is the very one that was shown, so that what is
 * drawn of it is not drawn again.
 */
export function mergeHead<T extends Item>(loaded: T[], fresh: T[], freshNext: string | null): T[] {
  const known = new Map(loaded.map((p) => [p.id, p]));
  const head = fresh.map((p) => {
    const was = known.get(p.id);
    return was && JSON.stringify(was) === JSON.stringify(p) ? was : p;
  });
  const last = head[head.length - 1];
  if (freshNext === null || !last) return head;
  const have = new Set(head.map((p) => p.id));
  return [...head, ...loaded.filter((p) => !have.has(p.id) && before(last, p))];
}

/** Whether two lists are the same items, the very same ones, in the same order. */
export const sameList = (a: readonly unknown[], b: readonly unknown[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** A page that was loaded further down joins the end of the list; one that was already there, from the top being asked for meanwhile, is not drawn twice. */
export function appendNew<T extends Item>(loaded: T[], page: T[]): T[] {
  const have = new Set(loaded.map((p) => p.id));
  return [...loaded, ...page.filter((p) => !have.has(p.id))];
}
