import { Suspense, useEffect, useMemo, useState, type MutableRefObject } from "react";
import { api } from "../api";
import { failedIn } from "../extensions/loader";
import { useSlot } from "../extensions/slots";
import { DEFAULT_ORB, type OrbState, type OrbStyle } from "../../../server/src/orb-style";
import { ErrorBoundary } from "./ErrorBoundary";
import { ORB_STYLE_EVENT, VoiceOrb, type VoiceLevels } from "./VoiceOrb";

/**
 * The agent a chat talks to, and its avatar: the default orb and no agent until
 * the server answers, then whatever is saved. Asked again when an avatar is
 * saved, since it can be this one.
 */
export function useChatAvatar(session: string): { agent?: { id: string; name: string }; look: OrbStyle } {
  const [avatar, setAvatar] = useState<{ agent?: { id: string; name: string }; look: OrbStyle }>({ look: DEFAULT_ORB });
  useEffect(() => {
    let live = true;
    const load = () => api.chatAvatar(session).then(({ agent, orb }) => { if (live) setAvatar({ agent, look: orb }); }).catch(() => {});
    void load();
    window.addEventListener(ORB_STYLE_EVENT, load);
    return () => { live = false; window.removeEventListener(ORB_STYLE_EVENT, load); };
  }, [session]);
  return avatar;
}

/**
 * An agent's avatar, wherever the portal shows one: the orb, or what an
 * extension draws in its place (`voice.avatar`) for an agent whose look chose
 * it (`look.avatar`, "<package>/<id>"). The orb is drawn while that entry is
 * not in the page (its extension is not installed, is switched off, has not
 * loaded or not registered it yet), and in place of it when it fails to draw,
 * which Settings → Extensions then says. `thinking` is the stage's (see
 * AvatarMode); `still` is for a picture of the agent rather than voice mode.
 *
 * The orb and the agent are made once for what they show: the stage is drawn
 * again with every token of a reply, and an extension's part is drawn again
 * only when what it is given changes.
 */
export function AgentAvatar({ look, agent, mode, thinking = false, levels, still = false }: {
  look: OrbStyle; agent?: { id: string; name: string }; mode: OrbState; thinking?: boolean; levels: MutableRefObject<VoiceLevels>; still?: boolean;
}) {
  const orb = useMemo(() => <VoiceOrb mode={mode} levels={levels} look={look} />, [mode, levels, look]);
  const id = agent?.id, name = agent?.name;
  const who = useMemo(() => (id === undefined || name === undefined ? undefined : { id, name }), [id, name]);
  const entry = useSlot("voice.avatar").find((e) => e.key === look.avatar);
  if (!entry || !who) return orb;
  return (
    <div className="voice-avatar-x" aria-hidden="true">
      <ErrorBoundary resetKey={`${entry.key}:${who.id}`} fallback={() => orb} onError={failedIn(entry.extension)}>
        {/* Its own: a part still being fetched would otherwise blank the page above it until it is. */}
        <Suspense fallback={orb}>
          <entry.component agent={who} mode={thinking ? "thinking" : mode} levels={levels} still={still} orb={orb} />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
