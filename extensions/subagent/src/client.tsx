import { Suspense } from "react";
import type { Portal } from "@pithagoras/extension-api";
import { msg, portal, setPortal, t } from "./portal";
import { de } from "./de";

/**
 * The subagent extension's browser half: its page in Settings, where how a subagent runs against the agent, the model
 * it runs on and how many run at once are set (web/SubagentSettings.tsx). Its texts in German are in de.ts.
 */
export default function subagent(given: Portal) {
  setPortal(given);
  portal.locale.add("de", de);
  // Only fetched once it is opened.
  const Settings = portal.ui.lazy(() => import("./web/SubagentSettings"), "SubagentSettings");

  portal.slots.register("settings.page", {
    id: "subagent",
    title: msg("Subagents"),
    icon: AgentsIcon,
    // Each leads to its part of the page, which is named for it (web/SubagentSettings.tsx).
    search: [
      { title: msg("Subagents"), section: msg("How a subagent runs against the agent"), words: "subagent subagents mode background interrupt teilagenten modus hintergrund unterbrechen" },
      { title: msg("Subagents at once"), section: msg("Subagents at once"), words: "subagent parallel limit slots at once teilagenten gleichzeitig" },
      { title: msg("Subagent model"), section: msg("Subagent model"), words: "subagent model llm teilagenten modell" },
    ],
    component: () => (
      <Suspense fallback={<p className="text-sm text-fg-subtle">{t("Loading…")}</p>}>
        <Settings />
      </Suspense>
    ),
  });
}

/** Its mark in Settings' list: one agent handing on to two. Drawn here, as the extension brings no icons of its own. */
function AgentsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="M9 6h6M8.1 8.1l7.8 7.8" />
    </svg>
  );
}
