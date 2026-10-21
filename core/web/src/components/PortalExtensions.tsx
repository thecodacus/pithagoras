import { VoiceAddon } from "./VoiceAddon";
import { MemoryAddon, SubagentAddon } from "./FeatureAddons";
import { useId, useState } from "react";
import { LuBot, LuBrain, LuMic } from "react-icons/lu";
import { msg, t } from "../i18n";
import { tabKeys } from "../tab-keys";

/** The add-ons, in the order they are listed. */
const addons = [
  { id: 'voice', label: msg('Voice'), Icon: LuMic },
  { id: 'subagents', label: msg('Subagents'), Icon: LuBot },
  { id: 'memory', label: msg('Memory'), Icon: LuBrain },
] as const;
type Addon = typeof addons[number]['id'];

/**
 * Optional pieces of the portal itself, as opposed to pi's packages.
 *
 * This is where an add-on is found before it exists. Its own page appears in
 * the sidebar once installed, which is the right place to live and the wrong
 * place to be discovered from — nothing was visible until it was already
 * running, so there was nowhere to press install.
 */
export function PortalExtensions({ onError }: { onError: (e: string) => void }) {
  const id = useId();
  const [selected, setSelected] = useState<Addon>('voice');
  const [visited, setVisited] = useState<Addon[]>(['voice']);
  const select = (addon: Addon) => {
    setSelected(addon);
    setVisited(previous => previous.includes(addon) ? previous : [...previous, addon]);
  };
  return <div>
    <p className="mb-4 text-xs text-fg-muted">{t("Install and manage the add-ons for your sessions.")}</p>
    <div role="tablist" aria-label={t("Add-ons")} onKeyDown={tabKeys} className="flex gap-1 rounded-xl border border-line bg-raised/40 p-1">
      {addons.map(({ id: addon, label, Icon }) => <button
        key={addon} id={`${id}-${addon}-tab`} type="button" role="tab"
        aria-selected={selected === addon} aria-controls={`${id}-${addon}-panel`}
        tabIndex={selected === addon ? 0 : -1} onClick={() => select(addon)}
        className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-2 sm:gap-2 sm:px-4 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${selected === addon ? 'bg-accent/12 text-accent shadow-sm ring-1 ring-inset ring-accent/25' : 'text-fg-muted hover:bg-fg/5 hover:text-fg'}`}
      ><Icon className="hidden h-4 w-4 shrink-0 sm:block" />{t(label)}</button>)}
    </div>
    {addons.map(({ id: addon }) => <div key={addon} role="tabpanel" id={`${id}-${addon}-panel`}
      aria-labelledby={`${id}-${addon}-tab`} hidden={selected !== addon}>
      {visited.includes(addon) && (addon === 'voice' ? <VoiceAddon onError={onError} />
        : addon === 'subagents' ? <SubagentAddon onError={onError} />
        : <MemoryAddon onError={onError} />)}
    </div>)}
  </div>;
}
