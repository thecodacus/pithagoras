import type { ReactNode } from "react";
import { api, type InstallNeed } from "../api";
import { t, tx } from "../i18n";
import { confirmDialog } from "./ConfirmDialog";

/**
 * Installing an extension with what it needs to run.
 *
 * An extension names the extensions it cannot work without, and does not start
 * until they are there. The server says what installing one brings with it
 * (install-plan.ts): each it requires that is not there as it needs it, and
 * what is done for it. The person is asked first, with each listed; then each
 * is installed or switched on, before what needs it, and the extension last.
 */

/** Where an install has come to: the package installed, or switched on, now, and which of how many it is. */
export interface InstallStep {
  name: string;
  n: number;
  of: number;
  switching: boolean;
}

/** One need, as the question before the install says it. */
function Need({ need, root }: { need: InstallNeed; root: string }) {
  const name = (
    <>
      <strong className="font-medium text-fg">{need.name}</strong> <span className="font-mono text-xs">{need.version ?? need.range}</span>
    </>
  );
  const said =
    need.action === "install"
      ? need.from === "shipped"
        ? tx("{name} is installed from the portal's own folder.", { name })
        : tx("{name} is installed from npm.", { name })
      : need.action === "switch-on"
        ? tx("{name} is installed but switched off: it is switched on.", { name })
        : need.action === "version"
          ? need.from === "shipped"
            ? tx("{name} is the one in the portal's own folder, and {range} is needed.", { name, range: <span className="font-mono text-xs">{need.range}</span> })
            : need.from === "npm"
              ? tx("{name} is the one installed from npm, and {range} is needed.", { name, range: <span className="font-mono text-xs">{need.range}</span> })
              : tx("{name} is installed, and {range} is needed: update it.", { name, range: <span className="font-mono text-xs">{need.range}</span> })
          : need.error
            ? tx("{name} could not be looked for on npm: {reason}", { name, reason: need.error })
            : tx("{name} is not in the portal's own folder or on npm.", { name });
  return (
    <li>
      {said}
      {need.for !== root && <span className="block text-xs text-fg-faint">{t("Needed by {name}", { name: need.for })}</span>}
    </li>
  );
}

/** What an extension being installed needs, each with what is done for it, and what it means for the rest to be missing. `below` another text of the question. */
function Needs({ name, needs, below }: { name: string; needs: InstallNeed[]; below: boolean }) {
  return (
    <div className={below ? "mt-2" : undefined}>
      <p>{t("{name} needs other extensions to run:", { name })}</p>
      <ul className="mt-1.5 list-disc space-y-1 pl-5">
        {needs.map((need) => (
          // One needed by two is listed twice where the version one leaves is not one the other takes.
          <Need key={`${need.name} ${need.for}`} need={need} root={name} />
        ))}
      </ul>
      {/* Anyone can publish to npm: what is installed from there is said to run with the agent's rights, whatever the install began with. */}
      {needs.some((need) => need.from === "npm" && need.action === "install") && (
        <p className="mt-1.5">{t("Those installed from npm run inside pi with the same rights as the agent — reading files, running commands. Install packages you trust.")}</p>
      )}
      {needs.some((need) => need.action === "missing" || need.action === "version") && (
        <p className="mt-1.5">{t("It can be installed without what is not there: it then waits, and Settings → Extensions says what for.")}</p>
      )}
    </div>
  );
}

/**
 * Installs the extension `spec` names, with what it needs. Resolves false when
 * the person said no, and throws what failed, naming the package it was.
 * `ask` is a question of the caller's own (npm's "Install it?"), asked with the
 * list; without it the person is asked only when something else is needed.
 * `progress` is told each package as it is done, and null at the end.
 */
export async function installExtension(spec: string, { ask, progress }: { ask?: { title: string; message: ReactNode }; progress?: (step: InstallStep | null) => void } = {}): Promise<boolean> {
  const plan = await api.installPlan(spec);
  const name = plan.name ?? spec;
  if (ask || plan.needs.length) {
    const yes = await confirmDialog({
      title: ask?.title ?? t("Install {name}?", { name }),
      message: (
        <>
          {ask?.message}
          {plan.needs.length > 0 && <Needs name={name} needs={plan.needs} below={!!ask?.message} />}
        </>
      ),
      confirmLabel: t("Install"),
    });
    if (!yes) return false;
  }
  const steps = [...plan.needs.filter((need) => need.action === "install" || need.action === "switch-on"), { name, spec, action: "install" as const }];
  try {
    for (const [at, step] of steps.entries()) {
      const switching = step.action === "switch-on";
      progress?.({ name: step.name, n: at + 1, of: steps.length, switching });
      try {
        if (switching) await api.setExtensionEnabled(step.spec!, true);
        else await api.installPackage(step.spec!);
      } catch (e) {
        // The extension's own failure is said as it always was; one of what it needs, with which it was.
        if (at === steps.length - 1) throw e;
        const vars = { need: step.name, name, reason: (e as Error).message };
        throw new Error(switching ? t("{need} could not be switched on, so {name} was not installed: {reason}", vars) : t("{need} could not be installed, so {name} was not: {reason}", vars));
      }
    }
  } finally {
    progress?.(null);
  }
  return true;
}

/** Where an install of more than one package has come to, said as it goes. */
export function InstallProgress({ step }: { step: InstallStep | null }) {
  if (!step || step.of < 2) return null;
  const vars = { name: step.name, n: step.n, total: step.of };
  return (
    <p role="status" className="mt-2 text-xs text-fg-muted">
      {step.switching ? t("Switching on {name}, {n} of {total}…", vars) : t("Installing {name}, {n} of {total}…", vars)}
    </p>
  );
}
