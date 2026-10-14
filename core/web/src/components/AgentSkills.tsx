import { useEffect, useState } from "react";
import { LuChevronDown, LuChevronRight, LuFileText } from "react-icons/lu";
import { api, type AgentSkill } from "../api";
import { t, tp } from "../i18n";
import { ago } from "../package-names";
import { Markdown } from "./Markdown";

/**
 * The skills an agent wrote for itself, on its Skills tab: what it made, when,
 * and what each says, so whoever it works for knows what it has taught itself.
 * They live in a `skills` folder in its home; the skills in Settings → Skills
 * are pi's own, for every agent, and are not listed here.
 */
export function AgentSkills({ agent }: { agent: { id: string; name: string } }) {
  const [data, setData] = useState<{ folder: string; skills: AgentSkill[] } | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [content, setContent] = useState<Record<string, string>>({});

  useEffect(() => {
    setData(null);
    setOpen(null);
    api.agentSkills(agent.id).then(setData).catch((e) => setError((e as Error).message));
  }, [agent.id]);

  const toggle = async (id: string) => {
    if (open === id) return setOpen(null);
    setOpen(id);
    if (content[id] === undefined) {
      try {
        const r = await api.agentSkill(agent.id, id);
        setContent((c) => ({ ...c, [id]: r.content }));
      } catch (e) {
        setError((e as Error).message);
      }
    }
  };

  if (error) return <div className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>;
  if (!data) return null;

  return (
    <div className="mt-4">
      <p className="mb-3 text-xs text-fg-muted">
        {t("Procedures {name} saved as skills, to use again. Each is available from its next conversation.", { name: agent.name })}{" "}
        <span className="font-mono text-fg-faint">{data.folder}</span>
      </p>
      {data.skills.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line px-3 py-8 text-center text-sm text-fg-subtle">
          {t("No skills yet. When {name} saves a procedure as a skill, it shows up here.", { name: agent.name })}
        </div>
      ) : (
        <ul className="space-y-2">
          {data.skills.map((s) => (
            <li key={s.id} className="rounded-xl border border-line bg-raised/40">
              <button type="button" aria-expanded={open === s.id} onClick={() => toggle(s.id)} className="flex w-full items-start gap-2 px-3 py-2.5 text-left">
                {open === s.id ? <LuChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-fg-faint" /> : <LuChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-fg-faint" />}
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-sm font-medium text-fg">{s.name}</span>
                    <span className="text-[11px] text-fg-faint">{ago(new Date(s.updatedAt).toISOString())}</span>
                    {s.files.length > 0 && (
                      <span className="text-[11px] text-fg-faint">{tp(s.files.length, "{n} more file", "{n} more files")}</span>
                    )}
                  </span>
                  {s.description && <span className="mt-0.5 block text-xs text-fg-muted">{s.description}</span>}
                </span>
              </button>
              {open === s.id && (
                <div className="border-t border-line px-4 py-3">
                  {content[s.id] === undefined ? (
                    <p className="text-xs text-fg-faint">{t("Loading…")}</p>
                  ) : (
                    <div className="prose prose-sm max-w-none">
                      {/* The frontmatter is what the card's header already says; as Markdown it reads as a heading. */}
                      <Markdown>{content[s.id].replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")}</Markdown>
                    </div>
                  )}
                  {s.files.length > 0 && (
                    <ul className="mt-3 space-y-0.5 border-t border-line pt-2 font-mono text-[11px] text-fg-faint">
                      {s.files.map((f) => (
                        <li key={f}><LuFileText className="mr-1 inline h-3 w-3" />{f}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
