import { useEffect, useState } from "react";
import type { Chat, MenuModel } from "@pithagoras/extension-api";
import { fetchChoice, setChoice, useChoice } from "./chat-model";
import { Select, portal, t } from "./portal";

/**
 * The row in a chat's model menu (`chat.model.menu`): its subagents run on the extension's default, the chat's own
 * model, or one named. Read when a subagent starts, so a change needs no reload. Drawn once what the chat has is known
 * (fetched with the chat, see client.tsx).
 */
export function ModelRow({ chat, models }: { chat: Chat; models: readonly MenuModel[] }) {
  portal.locale.use();
  const choice = useChoice(chat.id);
  const [error, setError] = useState<string | null>(null);
  // Asked again quietly as the menu opens, where it was asked a while ago.
  useEffect(() => fetchChoice(chat.id), [chat.id]);
  if (!choice) return null;
  const named = (value: string) => (value === "auto" ? t("this chat's model") : value);
  const value = choice.model ?? "";
  const pick = (next: string) => {
    setError(null);
    setChoice(chat.id, next === "" ? null : next).catch((e: Error) => setError(e.message));
  };
  return (
    <div className="px-3 py-1.5">
      <p className="text-[11px] text-fg-subtle">{t("Subagents in this chat run on")}</p>
      <Select
        aria-label={t("Subagents in this chat run on")}
        size="sm"
        className="mt-1 w-full"
        value={value}
        onChange={pick}
        options={[
          { value: "", label: t("Default — {model}", { model: named(choice.default) }) },
          { value: "auto", label: t("This chat's model"), hint: t("The one it is on when it starts one") },
          ...(value && value !== "auto" && !models.some((m) => `${m.provider}/${m.id}` === value) ? [{ value, label: value }] : []),
          ...models.map((m) => ({ value: `${m.provider}/${m.id}`, label: m.name || m.id, hint: `${m.provider}/${m.id}` })),
        ]}
      />
      {error && <p role="alert" className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}
