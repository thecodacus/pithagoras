import { useEffect, useRef, useState } from "react";
import { LuUsers } from "react-icons/lu";
import { portal, t } from "../portal";
import { api, sayError } from "./api";
import { useOfficeState } from "./state";

/**
 * The Office editor's host: the page's half of `new DocsAPI.DocEditor`. It asks POST /editor-config for its
 * document, loads the Document Server's api.js ONCE (the script is not idempotent -- a second load on the same
 * page breaks it), drops ONLY apiJs from the answered config and hands the rest to DocsAPI as-is: the JWT covers
 * exactly that object (plan 5.6 signs what is sent, so nothing is added to it). The lock badge ("N editing now")
 * and the "agent updated this document" badge come from the shared 5 s poll of /state -- plan 5.7 tier 1; the
 * real refreshFile handshake that would replace the page refresh is deferred (M0/M4).
 */

/** What DocsAPI leaves on window once api.js has loaded: only what is used, typed as it behaves. */
interface DocsApiLike {
  DocEditor: new (el: HTMLElement, config: Record<string, unknown>) => DestroyableEditor;
}
interface DestroyableEditor {
  destroyEditor?: () => void;
}

declare global {
  interface Window {
    DocsAPI?: DocsApiLike;
  }
}

/** api.js per address, loaded once per page: the promise is cached, and a failure stays said until the page reloads. */
const scripts = new Map<string, Promise<void>>();
function loadScript(src: string): Promise<void> {
  const known = scripts.get(src);
  if (known) return known;
  const load = new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`the editor script at ${src} could not be loaded`));
    document.head.appendChild(el);
  });
  scripts.set(src, load);
  return load;
}

export function OfficeEditor({ docId, onBack }: { docId: string; onBack(): void }) {
  portal.locale.use();
  const state = useOfficeState();
  const doc = state?.docs.find((d) => d.docId === docId);
  const [problem, setProblem] = useState<string | null>(null);
  /** The Document Server has filled its iframe into the placeholder: the loading state is done. */
  const [ready, setReady] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const editor = useRef<DestroyableEditor | null>(null);
  // What mtimeMs was in effect when this view opened (the revision the minted key carries, as near as the page
  // knows it -- /state already had the doc by the time it could be opened): a poll that is newer than it means
  // an agent edited meanwhile, which tier 1 says with the badge below.
  const openedAt = useRef<number | null>(null);

  useEffect(() => {
    if (openedAt.current === null && doc) openedAt.current = doc.mtimeMs;
  }, [doc]);

  useEffect(() => {
    let alive = true;
    let watch: ReturnType<typeof setInterval> | undefined;
    setProblem(null);
    setReady(false);
    void (async () => {
      try {
        const minted = await api.editorConfig(docId);
        if (!alive || !box.current) return;
        await loadScript(minted.apiJs);
        if (!alive || !box.current) return;
        // The JWT was signed over the config WITHOUT these two fields: drop exactly apiJs, send the rest unaltered.
        const config: Record<string, unknown> = { ...minted };
        delete config.apiJs;
        if (!window.DocsAPI) throw new Error("api.js loaded but DocsAPI is not on window -- the Document Server answered with something that is not its script");
        editor.current = new window.DocsAPI.DocEditor(box.current, config);
        // onDocumentReady, as close to it as this tier can get: DS fills its own iframe into the placeholder.
        watch = setInterval(() => {
          if (box.current?.querySelector("iframe")) {
            setReady(true);
            if (watch !== undefined) clearInterval(watch);
          }
        }, 500);
      } catch (e) {
        if (alive) setProblem(sayError(e));
      }
    })();
    return () => {
      alive = false;
      if (watch !== undefined) clearInterval(watch);
      try {
        editor.current?.destroyEditor?.(); // where the loaded api.js exposes it
      } catch {
        // a destroyed or half-built editor must not take the page down with it
      }
      editor.current = null;
    };
  }, [docId]);

  const users = state?.locks[docId] ?? [];
  // An agent wrote a newer revision than the one this view opened on (plan 5.7 tier-1 badge).
  const stale = openedAt.current !== null && !!doc && doc.mtimeMs > openedAt.current;

  return (
    <div className="po-page po-editor po-editor-page">
      <div className="po-editor-bar">
        <button type="button" className={portal.ui.classes.ghost} onClick={onBack}>
          ← {t("All documents")}
        </button>
        <span className="po-editor-title">{doc ? `${doc.title}.${doc.ext}` : "…"}</span>
        <span className="po-editor-spacer" />
        {users.length > 0 && (
          <span className="po-chip po-chip-lock" title={users.map((u) => u.name ?? u.id).join(", ")}>
            <LuUsers aria-hidden />
            {users.length === 1 ? t("1 editing now") : t("{n} editing now", { n: users.length })}
          </span>
        )}
        {stale && (
          <span className="po-chip po-chip-stale">
            {t("The agent updated this document")}
            {" — "}
            <button type="button" className="po-refresh" onClick={() => window.location.reload()}>
              {t("refresh to see their changes")}
            </button>
          </span>
        )}
      </div>
      {problem && (
        <portal.ui.ErrorBanner>
          {problem}{" "}
          <button
            type="button"
            className={portal.ui.classes.ghost}
            onClick={() => portal.navigate(`/settings/x/${portal.extension}`)}
          >
            {t("Open the Office settings")}
          </button>
        </portal.ui.ErrorBanner>
      )}
      <div className="po-host" ref={box}>
        {!ready && !problem && (
          <div className="po-loading">
            {t("Loading the editor — the first start of a Document Server can take a while…")}
          </div>
        )}
      </div>
    </div>
  );
}
