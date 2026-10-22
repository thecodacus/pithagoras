import { useSlot } from "../extensions/slots";
import { extensionsOff, failedIn, useExtensions } from "../extensions/loader";
import { ErrorBoundary, PartFailed } from "./ErrorBoundary";
import { t } from "../i18n";

/**
 * A page an extension brought: the `nav.page` entry the address names, given
 * the page's room to draw in. `entryKey` is `<extension>/<id>`.
 */
export function ExtensionPage({ entryKey }: { entryKey: string }) {
  const entry = useSlot("nav.page").find((e) => e.key === entryKey);
  const { settled, failures } = useExtensions();
  // Opened with ?extensions=off: no extension is loaded into this page, nor will be.
  if (!entry && extensionsOff()) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-fg-subtle" role="status">
        <p>{t("This page was opened with ?extensions=off: no extension is loaded into it.")}</p>
      </div>
    );
  }
  if (!entry) {
    // Before the installed extensions have been gone through, it may only not be there yet.
    const failure = Object.entries(failures).find(([name]) => entryKey.startsWith(`${name}/`))?.[1];
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-fg-subtle" role={settled ? "alert" : "status"}>
        <p>{!settled ? t("Loading…") : failure ? t("This page's extension could not be loaded.") : t("This page's extension is not installed, or is switched off.")}</p>
        {settled && failure && <p className="max-w-md break-words font-mono text-[11px] text-fg-faint">{failure}</p>}
      </div>
    );
  }
  const Page = entry.component;
  return (
    <div className="extension-page min-h-0 flex-1 overflow-y-auto" data-extension={entry.extension}>
      {/* An extension's page failing to draw takes down that page, not the portal. */}
      <ErrorBoundary resetKey={entry.key} fallback={(error) => <div className="p-6"><PartFailed error={error} /></div>} onError={failedIn(entry.extension)}>
        <Page />
      </ErrorBoundary>
    </div>
  );
}
