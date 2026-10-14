import { ApiError, type Unsaved } from "./api";
import { t, tp } from "./i18n";

/**
 * What a delete would lose that only the folder has, in the words a confirmation
 * uses: the git sentences, and whether the question must be asked whatever
 * Settings says. The same for a project and for a folder in the Files panel.
 *
 * `lost` is whether there is something to name, `risky` whether there is
 * something to ask about — also when the folder could not be read, which is not
 * said as if it were a fact, since what could not be read may be nothing.
 */
export function unsavedNotes(u: Unsaved | undefined): { lost: boolean; risky: boolean; sentences: string[] } {
  const lost = u
    ? [
        u.changed ? tp(u.changed, "{n} uncommitted change", "{n} uncommitted changes") : "",
        u.unpushed ? tp(u.unpushed, "{n} commit that no remote has", "{n} commits that no remote has") : "",
        u.stashes ? tp(u.stashes, "{n} stash", "{n} stashes") : "",
      ].filter(Boolean)
    : [];
  const sentences = [
    lost.length ? t("This folder holds git work that exists nowhere else: {list}.", { list: lost.join(", ") }) : "",
    u?.unknown
      ? lost.length
        ? t("There may be more: not everything in it could be read.")
        : t("Whether the folder holds git work that exists nowhere else could not be told.")
      : "",
    // Only where git could be asked: a folder too big to look through may have no git at all.
    u && (lost.length || !u.unknown) ? t("Files git ignores, such as .env, are not looked at.") : "",
  ].filter(Boolean);
  return { lost: lost.length > 0, risky: lost.length > 0 || !!u?.unknown, sentences };
}

/**
 * A delete that asks first, and asks again when the server finds work the
 * question did not name — made, say, while it was on screen. `ask` answers
 * whether to go ahead and whether that work may go with it (null for "no");
 * `del` sends it, with `?discard=1` when it may. True when it was deleted.
 */
export async function deleteAsking(
  unsaved: Unsaved | null | undefined,
  ask: (unsaved: Unsaved | undefined) => Promise<boolean | null>,
  del: (discard: boolean) => Promise<unknown>,
): Promise<boolean> {
  for (;;) {
    const discard = await ask(unsaved ?? undefined);
    if (discard === null) return false;
    try {
      await del(discard);
      return true;
    } catch (e) {
      if (discard || !(e instanceof ApiError) || e.body.code !== "unsaved-work") throw e;
      unsaved = e.body.unsaved as Unsaved;
    }
  }
}
