import { Component, type ReactNode } from "react";
import { LuRotateCw, LuTriangleAlert } from "react-icons/lu";
import { t } from "../i18n";
import { ChunkLoadFailed } from "../lazy";
import { Modal } from "./Modal";
import { primarySmCls } from "./SettingsUi";

/**
 * What a page that threw is replaced with, instead of the whole portal going
 * blank: the sidebar stays, the other pages still open, and this one can be
 * tried again. `resetKey` changing — another page, another chat — starts over.
 * `fallback` is what is shown instead of the page's own message, for what is not
 * a page.
 */
export class ErrorBoundary extends Component<{ resetKey: string; fallback?: (error: Error) => ReactNode; children: ReactNode }, { error: Error | null; key: string }> {
  state = { error: null as Error | null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: { resetKey: string }, state: { error: Error | null; key: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  componentDidCatch(error: Error) {
    console.error("[portal] a page failed to draw:", error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error);
    // A part that could not be fetched fails again however often it is asked for: only a reload helps.
    const fetching = error instanceof ChunkLoadFailed;
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="grid h-11 w-11 place-items-center rounded-2xl bg-danger/10 text-danger">
          <LuTriangleAlert className="h-5 w-5" />
        </div>
        <p className="text-sm text-fg">{fetching ? <FetchFailed /> : t("This page ran into a problem and could not be shown.")}</p>
        <p className="max-w-md break-words font-mono text-[11px] text-fg-faint">{error.message}</p>
        <div className="mt-1 flex gap-2">
          {fetching ? (
            <button type="button" onClick={() => window.location.reload()} className={primarySmCls}>
              <LuRotateCw className="h-3.5 w-3.5" /> {t("Reload the portal")}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => this.setState({ error: null })}
                className={primarySmCls}
              >
                <LuRotateCw className="h-3.5 w-3.5" /> {t("Try again")}
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="rounded-lg px-3 py-1.5 text-sm text-fg-muted transition hover:bg-fg/5 hover:text-fg"
              >
                {t("Reload the portal")}
              </button>
            </>
          )}
        </div>
      </div>
    );
  }
}

/** Why a part of the portal could not be fetched. */
const FetchFailed = () => (
  <>{t("The part of the portal that opens this could not be loaded. This happens when the portal was updated while this page was open.")}</>
);

/**
 * What a part of the portal that is not a page (a dialog, a panel) is replaced
 * with, once it could not be drawn. A file that a portal updated since this
 * page was opened no longer has is not found again by trying, so a reload is
 * what there is to offer then; any other failure says what it was, as a page
 * does, and its reload would only draw it again.
 */
export function PartFailed({ error }: { error: Error }) {
  const fetching = error instanceof ChunkLoadFailed;
  return (
    <div role="alert" className="flex flex-col items-start gap-3 text-sm text-fg-muted">
      <p>{fetching ? <FetchFailed /> : t("This part of the portal ran into a problem and could not be shown.")}</p>
      <p className="max-w-md break-words font-mono text-[11px] text-fg-faint">{error.message}</p>
      {fetching && (
        <button type="button" onClick={() => window.location.reload()} className={primarySmCls}>
          <LuRotateCw className="h-3.5 w-3.5" /> {t("Reload the portal")}
        </button>
      )}
    </div>
  );
}

/** What a dialog is replaced with when it could not be drawn: the portal stays, and the dialog can be closed. */
export function DialogFailed({ error, onClose }: { error: Error; onClose: () => void }) {
  return (
    <Modal title={t("Could not be opened")} onClose={onClose}>
      <PartFailed error={error} />
    </Modal>
  );
}
