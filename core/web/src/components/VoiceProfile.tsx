import { TRACE_STATUS, voiceProfileSummary, type VoiceProfiler } from '../voice-profile';
import { labelOf, t } from "../i18n";
export function VoiceProfile({profiler,onClose}:{profiler:VoiceProfiler;onClose:()=>void}){
 const trace=profiler.traces.at(-1),summary=trace&&voiceProfileSummary(trace);
 const download=()=>{const data=profiler.traces.map(t=>({...t,summary:voiceProfileSummary(t)}));const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='voice-latency.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
 return <aside className="voice-profile" aria-label={t("Voice latency profiler")}><header><strong>{t("Voice latency")}</strong><button onClick={onClose} aria-label={t("Close voice profiler")}>×</button></header>
 <p>{trace?t('Turn {id} · {status}',{id:trace.id,status:labelOf(TRACE_STATUS,trace.status)}):t("Speak a turn to begin recording.")}</p>
 {summary?<><strong>{t('{n}s from last detected speech to reply audio',{n:(summary.totalMs/1000).toFixed(2)})}</strong><table><tbody>{summary.stages.map(s=><tr key={s.label}><td>{t(s.label)}</td><td>{Math.round(s.ms)} ms</td><td>{s.percent.toFixed(1)}%</td></tr>)}</tbody></table></>:<p>{t("Waiting for the first generated reply to play…")}</p>}
 <p>{t("Output time is an AudioContext scheduling estimate, not a microphone measurement. Filler phrases are excluded. Stages are wall-clock intervals, not GPU compute times.")}</p>
 <details><summary>{t('Raw timing events ({n})',{n:trace?.marks.length??0})}</summary><pre>{trace?.marks.map(m=>`${Math.round(m.at-trace.started)}ms ${m.name} ${m.detail?JSON.stringify(m.detail):''}`).join('\n')}</pre></details>
 <button disabled={!profiler.traces.length} onClick={download}>{t("Download timing report")}</button>
 </aside>;
}
