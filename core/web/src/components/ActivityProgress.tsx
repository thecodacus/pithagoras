import { useNow } from '../use-now';
import { formatElapsed, prefillShare, promptLabel, type Activity } from '../transcript';
import { t } from "../i18n";

/** How far the prompt has been read, or that the conversation is being compacted, in the voice stage's own light. */
export function ActivityProgress({ phase }: { phase: Activity }) {
  const now = useNow(true);
  const seconds = Math.max(0, Math.floor((now - (phase.since ?? now)) / 1000));
  const { percent } = prefillShare(phase.prefill);
  const compacting = phase.label === 'compacting the conversation';
  const elapsed = formatElapsed(seconds);
  if (!compacting && seconds < 2) return null;
  return <div className="activity-progress">
    <div className="activity-progress-heading"><span role="status">{compacting ? t("Compacting conversation") : `${promptLabel(seconds)}…`}</span><span>{percent !== undefined ? `${percent}% · ` : ''}{elapsed}</span></div>
    <div className="activity-progress-track" role="progressbar" aria-label={compacting ? t("Conversation compaction") : t("Prompt processing")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <div className={percent === undefined ? 'activity-progress-indeterminate' : ''} style={percent === undefined ? undefined : {width: `${percent}%`}} />
    </div>
  </div>;
}
