import { LuRotateCw, LuTriangleAlert } from "react-icons/lu";
import { useExtensions } from "../extensions/loader";
import { t } from "../i18n";
import { primarySmCls } from "./SettingsUi";

/**
 * The line at the top of the page that says it could not take the old version of an extension out cleanly as what is
 * installed changed (see leftBehind in extensions/loader.ts), with a Reload: the page loaded again runs what is
 * installed now and nothing else. One line for all of them; nothing while every change went in cleanly.
 */
export function ExtensionsLeftBehind() {
  const { leftBehind } = useExtensions();
  if (!leftBehind.length) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-warn/10 px-4 py-2 text-sm text-fg">
      <LuTriangleAlert aria-hidden className="h-4 w-4 shrink-0 text-warn" />
      <span className="min-w-0 flex-1">
        {t("This page could not take out the old version of {names} cleanly. Reload it to run what is installed now.", { names: leftBehind.join(", ") })}
      </span>
      <button type="button" onClick={() => window.location.reload()} className={primarySmCls}>
        <LuRotateCw aria-hidden className="h-3.5 w-3.5" /> {t("Reload")}
      </button>
    </div>
  );
}
