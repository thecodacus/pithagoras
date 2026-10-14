import { useEffect, useMemo, useState } from "react";
import { LuRotateCcw } from "react-icons/lu";
import { FIXED, bindingOf, defaults, describe, movesFocus, resetAll, resetBinding, setBinding, useActions, useKeyLabels, useKeybindings, type ActionId } from "../keybindings";
import { actionLabel } from "../extensions/shortcuts";
import { t } from "../i18n";
import { useCommandTrigger } from "../command-trigger";

const btnCls = "inline-flex items-center gap-1.5 rounded-lg bg-fg/5 px-2.5 py-1.5 text-xs text-fg transition hover:bg-fg/10 disabled:opacity-40";
const kbdCls = "inline-flex min-w-[2rem] justify-center rounded-md border border-line bg-raised px-2 py-0.5 font-mono text-xs text-fg shadow-[inset_0_-1px_0_rgb(var(--line))]";

/**
 * Every keyboard shortcut, and a way to change the ones that can be.
 *
 * Changing one listens for the next key pressed, with whatever modifiers are
 * held — Escape included, since Escape is a fine shortcut, so it is Cancel
 * that takes it back; Tab is none, and ends the listening. A key another action already has moves to this one, and
 * the list says which lost it. Kept in this browser.
 */
export function KeyboardShortcuts() {
  const bindings = useKeybindings();
  // The portal's own, and the extensions' after them.
  const actions = useActions();
  const layout = useKeyLabels();
  const trigger = useCommandTrigger();
  const [recording, setRecording] = useState<ActionId | null>(null);
  // What each would have with nothing chosen: an extension's default gives way to a key another action has.
  const plain = useMemo(() => defaults(), [actions]);
  // An extension taken out while its shortcut listens for a key: nothing is listening for it any more.
  useEffect(() => {
    if (recording && !actions.some((a) => a.id === recording)) setRecording(null);
  }, [actions, recording]);
  // Said in the language shown when it is drawn.
  const [note, setNote] = useState<(() => string) | null>(null);

  useEffect(() => {
    if (!recording) return;
    const take = (e: KeyboardEvent) => {
      // Tab is not a shortcut but the way on to the next button, and the keyboard is how this was reached:
      // it ends the listening and goes on its way.
      if (movesFocus({ code: e.code, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey })) {
        setNote(() => () => t("Tab moves between buttons, so it cannot be a shortcut."));
        setRecording(null);
        return;
      }
      // Before anything else on the page sees it: Escape would close the dialog.
      e.preventDefault(); e.stopPropagation();
      const binding = bindingOf(e);
      if (!binding) return;
      const took = setBinding(recording, binding);
      const taken = actions.find(a => a.id === took);
      const label = taken && actionLabel(taken);
      setNote(label ? () => () => t("{keys} was used for “{action}”, which now has no shortcut.", { keys: describe(binding, layout), action: label }) : null);
      setRecording(null);
    };
    const swallow = (e: KeyboardEvent) => { e.preventDefault(); e.stopPropagation(); };
    window.addEventListener("keydown", take, true);
    window.addEventListener("keyup", swallow, true);
    return () => { window.removeEventListener("keydown", take, true); window.removeEventListener("keyup", swallow, true); };
  }, [recording, layout, actions]);

  const changed = actions.some(a => describe(bindings[a.id], null, false) !== describe(plain[a.id], null, false));
  return <div className="xl:grid xl:grid-cols-[3fr_2fr] xl:items-start xl:gap-x-8">
    <section className="mb-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">{t("Voice mode")}</h3>
          <p className="mt-0.5 text-xs text-fg-subtle">
            {t("Work while voice mode is on, except when typing in a field. Starting voice mode works from the chat too. Kept in this browser.")}
          </p>
        </div>
        <button className={`${btnCls} shrink-0 whitespace-nowrap`} disabled={!changed} onClick={() => { resetAll(); setNote(null); setRecording(null); }}><LuRotateCcw className="h-3.5 w-3.5" />{t("Reset all")}</button>
      </div>
      {note && <p role="status" className="mt-2 rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">{note()}</p>}
      <ul className="mt-2.5 divide-y divide-line rounded-xl border border-line bg-raised/40" aria-label={t("Voice mode shortcuts")}>
        {actions.map(action => {
          const binding = bindings[action.id];
          const isDefault = describe(binding, null, false) === describe(plain[action.id], null, false);
          const listening = recording === action.id;
          return <li key={action.id} className="flex flex-wrap items-center gap-2 px-3 py-2" aria-label={actionLabel(action)}>
            <span className="min-w-0 flex-1 text-sm text-fg">
              {actionLabel(action)}
              {/* Whose it is, for a shortcut an extension brought. */}
              {action.extension && <span className="ml-2 text-[11px] text-fg-faint">{action.extension}</span>}
            </span>
            {listening
              ? <span className="text-xs text-accent" role="status">{t("Press the new keys…")}</span>
              : binding ? <kbd className={kbdCls}>{describe(binding, layout)}</kbd> : <span className="text-xs text-fg-faint">{t("None")}</span>}
            <div className="flex gap-1">
              {listening
                ? <button className={btnCls} onClick={() => setRecording(null)}>{t("Cancel")}</button>
                : <button className={btnCls} onClick={() => { setNote(null); setRecording(action.id); }}>{t("Change")}</button>}
              <button className={btnCls} disabled={listening || !binding} onClick={() => { setBinding(action.id, null); setNote(null); }}>{t("Clear")}</button>
              <button className={btnCls} disabled={listening || isDefault} title={t("Back to {keys}", { keys: describe(plain[action.id], layout) || t("none") })} onClick={() => {
                const took = resetBinding(action.id);
                const taken = actions.find(a => a.id === took);
      const label = taken && actionLabel(taken);
                setNote(label ? () => () => t("That was used for “{action}”, which now has no shortcut.", { action: label }) : null);
              }}>{t("Reset")}</button>
            </div>
          </li>;
        })}
      </ul>
    </section>
    <section className="mb-6">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">{t("Chat")}</h3>
      <p className="mt-0.5 text-xs text-fg-subtle">{t("Part of how the message box works, so they are fixed. The character that opens the command list is the one exception: it is set under This browser.")}</p>
      <ul className="mt-2.5 divide-y divide-line rounded-xl border border-line bg-raised/40" aria-label={t("Chat shortcuts")}>
        {FIXED.map(item => <li key={item.label} className="flex items-center gap-2 px-3 py-2">
          <span className="min-w-0 flex-1 text-sm text-fg">{t(item.label)}</span>
          <kbd className={kbdCls}>{item.command ? trigger : describe(item.keys, layout)}</kbd>
        </li>)}
      </ul>
    </section>
  </div>;
}
