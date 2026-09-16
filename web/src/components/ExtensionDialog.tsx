import { useEffect, useState } from "react";
import { LuCheck, LuTerminal, LuX } from "react-icons/lu";
import { api } from "../api";

export interface UiRequest {
  id: string;
  method: "select" | "confirm" | "input" | "editor" | string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  defaultValue?: string;
}

/**
 * The browser standing in for the TUI when an extension asks the user
 * something. Without this, pi hands the extension a default straight away and
 * commands that open a menu appear to do nothing.
 */
export function ExtensionDialog({
  sessionId,
  request,
  onDone,
}: {
  sessionId: string;
  request: UiRequest;
  onDone: () => void;
}) {
  const [value, setValue] = useState(request.defaultValue ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const respond = async (payload: { value?: unknown; cancelled?: boolean }) => {
    if (busy) return;
    if (payload.cancelled && error) { onDone(); return; }
    setBusy(true);
    setError("");
    try {
      const result = await api.respondUi(sessionId, request.id, payload);
      if (!result.ok) { setError(result.note || "This question has expired. Your answer was not delivered."); return; }
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && respond({ cancelled: true });
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [request.id, busy, error]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-canvas/80 p-4 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && respond({ cancelled: true })}
    >
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-line bg-surface shadow-pop">
        <header className="flex items-start gap-3 border-b border-line px-4 py-3">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent">
            <LuTerminal className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium text-fg">{request.title || "Extension"}</h2>
            {request.message && (
              <p className="mt-0.5 text-xs text-fg-muted">{request.message}</p>
            )}
          </div>
          <button
            onClick={() => respond({ cancelled: true })}
            className="rounded-lg p-1 text-fg-subtle transition hover:bg-fg/10 hover:text-fg"
          >
            <LuX className="h-4 w-4" />
          </button>
        </header>

        {error && <p role="alert" className="border-b border-line px-4 py-3 text-sm text-danger">{error}</p>}
        <div className="max-h-[55vh] overflow-y-auto p-3">
          {request.method === "select" && (
            <ul className="space-y-1">
              {(request.options ?? []).map((opt) => (
                <li key={opt}>
                  <button
                    disabled={busy}
                    onClick={() => respond({ value: opt })}
                    className="w-full truncate rounded-lg px-3 py-2 text-left text-sm text-fg transition hover:bg-fg/10 disabled:opacity-40"
                  >
                    {opt}
                  </button>
                </li>
              ))}
              {(request.options ?? []).length === 0 && (
                <p className="px-3 py-2 text-sm text-fg-subtle">No options offered.</p>
              )}
            </ul>
          )}

          {(request.method === "input" || request.method === "editor") && (
            <>
              {request.method === "editor" ? (
                <textarea
                  autoFocus
                  rows={10}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  className="w-full resize-y rounded-lg border border-line bg-raised/60 px-3 py-2 font-mono text-xs text-fg outline-none focus:border-accent/60"
                />
              ) : (
                <input
                  autoFocus
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && respond({ value })}
                  placeholder={request.placeholder}
                  className="w-full rounded-lg border border-line bg-raised/60 px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-faint focus:border-accent/60"
                />
              )}
              <div className="mt-3 flex justify-end gap-2">
                <button
                  onClick={() => respond({ cancelled: true })}
                  className="rounded-lg px-3 py-1.5 text-sm text-fg-muted hover:bg-fg/10"
                >
                  Cancel
                </button>
                <button
                  disabled={busy}
                  onClick={() => respond({ value })}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-accent/12 px-3 py-1.5 text-sm text-accent ring-1 ring-inset ring-accent/25 hover:bg-accent/20 disabled:opacity-40"
                >
                  <LuCheck className="h-3.5 w-3.5" /> Submit
                </button>
              </div>
            </>
          )}

          {request.method === "confirm" && (
            <div className="flex justify-end gap-2">
              <button
                disabled={busy}
                onClick={() => respond({ value: false })}
                className="rounded-lg px-3 py-1.5 text-sm text-fg-muted hover:bg-fg/10"
              >
                No
              </button>
              <button
                disabled={busy}
                onClick={() => respond({ value: true })}
                className="rounded-lg bg-accent/12 px-3 py-1.5 text-sm text-accent ring-1 ring-inset ring-accent/25 hover:bg-accent/20"
              >
                Yes
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
