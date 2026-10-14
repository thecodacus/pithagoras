import { useEffect, useId, useRef, useState } from "react";
import { LuArrowRight, LuBot, LuCheck, LuRefreshCw, LuUser } from "react-icons/lu";
import { type AgentWizard } from "../api";
import { isEnter } from "../shortcuts";
import { ghostCls, inputCls, primaryCls } from "./SettingsUi";
import { SetupNav, SetupSteps } from "./SetupSteps";
import { msg, t } from "../i18n";

const STEPS = [msg("Who it is"), msg("Who it works for")];
type Step = 0 | 1;

/**
 * First run for an agent's home directory, or a new agent: the same two
 * questions either way.
 *
 * Two questions, because the two things the agent cannot work out for itself
 * are who it is and who it is talking to. Everything else has a sensible
 * starting point, and the files are editable afterwards.
 *
 * `home` is where the files go, when there is one yet. With `onCancel` it is a
 * new agent, which can be given up on.
 */
export function AgentSetup({
  home,
  onSubmit,
  onCancel,
}: {
  home?: string;
  onSubmit: (input: AgentWizard) => Promise<void>;
  onCancel?: () => void;
}) {
  const [step, setStep] = useState<Step>(0);
  const [agentName, setAgentName] = useState("");
  const [vibe, setVibe] = useState("");
  const [userName, setUserName] = useState("");
  const [userAbout, setUserAbout] = useState("");
  const [userPrefers, setUserPrefers] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const userField = useRef<HTMLInputElement>(null);
  const aboutUser = useId();

  // Create took the focus with it when it disabled the form: a failure gives
  // it back, where the name is fixed and sent again.
  useEffect(() => {
    if (!busy && error) userField.current?.focus();
  }, [busy, error]);

  const go = (to: Step) => {
    setError(null);
    setStep(to);
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ agentName, vibe, userName, userAbout, userPrefers });
    } catch (e) {
      setError((e as Error).message);
    }
    // Whatever the answer: where it makes this page go away, setting it is nothing, and where the wizard stays the form is not left disabled.
    setBusy(false);
  };

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-10">
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent/12 text-accent">
          <LuBot className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-fg">{onCancel ? t("New agent") : t("Set up the agent")}</h2>
          <p className="mt-0.5 text-sm text-fg-muted">
            {onCancel
              ? t("An agent of its own, with its own character, memory and files in a folder of its own. Two questions and it has somewhere to start.")
              : t("Its channels talk to it, and it keeps what it learns. Two questions and it has somewhere to start.")}
          </p>
          {home && <p className="mt-1 truncate font-mono text-[11px] text-fg-faint">{home}</p>}
        </div>
      </div>

      <div className="mt-6">
        <SetupSteps steps={STEPS} current={step} />
      </div>

      {step === 0 ? (
        <section className="mt-6 space-y-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            <LuBot className="h-3.5 w-3.5" /> {t(STEPS[0])}
          </div>

          <label className="block">
            <span className="text-xs text-fg-muted">{t("Name")}</span>
            <input
              autoFocus
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              onKeyDown={(e) => isEnter(e) && agentName.trim() && go(1)}
              placeholder="Nova"
              className={`${inputCls} mt-1`}
            />
          </label>

          <label className="block">
            <span className="text-xs text-fg-muted">{t("Character")}</span>
            <textarea
              value={vibe}
              onChange={(e) => setVibe(e.target.value)}
              rows={5}
              placeholder={t("How it should come across. Direct and a bit dry? Careful and thorough? Leave it empty for a sensible default you can edit later.")}
              className={`${inputCls} mt-1 resize-y text-xs leading-relaxed`}
            />
            <p className="mt-1 text-[11px] text-fg-faint">{t("Becomes SOUL.md.")}</p>
          </label>

          <SetupNav leave={onCancel && <button type="button" onClick={onCancel} className={ghostCls}>{t("Cancel")}</button>}>
            <button disabled={!agentName.trim()} onClick={() => go(1)} className={primaryCls}>
              {t("Next")} <LuArrowRight className="h-4 w-4" />
            </button>
          </SetupNav>
        </section>
      ) : (
        // Nothing changes while Create runs: an edit would miss what is sent,
        // and its error shows on this step only.
        <fieldset disabled={busy} aria-labelledby={aboutUser} className="mt-6 min-w-0 space-y-4">
          <div id={aboutUser} className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            <LuUser className="h-3.5 w-3.5" /> {t(STEPS[1])}
          </div>

          <label className="block">
            <span className="text-xs text-fg-muted">{t("Your name")}</span>
            <input
              ref={userField}
              autoFocus
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              onKeyDown={(e) => isEnter(e) && userName.trim() && void create()}
              placeholder="Sam"
              className={`${inputCls} mt-1`}
            />
          </label>

          <label className="block">
            <span className="text-xs text-fg-muted">{t("About you")}</span>
            <textarea
              value={userAbout}
              onChange={(e) => setUserAbout(e.target.value)}
              rows={4}
              placeholder={t("What you work on, what you care about, anything it should assume rather than ask.")}
              className={`${inputCls} mt-1 resize-y text-xs leading-relaxed`}
            />
          </label>

          <label className="block">
            <span className="text-xs text-fg-muted">{t("How to answer you")}</span>
            <textarea
              value={userPrefers}
              onChange={(e) => setUserPrefers(e.target.value)}
              rows={3}
              placeholder={t("Short and blunt? Show the reasoning? Never guess?")}
              className={`${inputCls} mt-1 resize-y text-xs leading-relaxed`}
            />
            <p className="mt-1 text-[11px] text-fg-faint">{t("Becomes PrimaryUser.md.")}</p>
          </label>

          {error && <p role="alert" className="text-xs text-danger">{error}</p>}

          <SetupNav onBack={() => go(0)} busy={busy}>
            <button disabled={!userName.trim()} onClick={create} className={primaryCls}>
              {busy ? (
                <LuRefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <LuCheck className="h-4 w-4" />
              )}
              {t("Create")}
            </button>
          </SetupNav>
        </fieldset>
      )}

      <p className="mt-8 text-[11px] leading-relaxed text-fg-faint">
        {t("Writes SOUL.md, PrimaryUser.md and MEMORY.md into the agent's home directory. All three are handed to pi as context whenever a conversation starts, and stay editable here. A file that is already there is never overwritten.")}
      </p>
    </div>
  );
}
