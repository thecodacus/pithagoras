export type VoiceCue = 'start' | 'end' | 'sent' | 'mute' | 'unmute' | 'focus';
/** Brief, quiet UI tones, synthesized locally without audio downloads. */
export function voiceCue(audio: AudioContext, kind: VoiceCue) {
  if (audio.state !== 'running') return;
  const notes: Record<VoiceCue, number[]> = { start: [440, 660], end: [440, 330], sent: [620], mute: [320], unmute: [480, 640], focus: [520, 780] };
  notes[kind].forEach((frequency, i) => {
    const oscillator = audio.createOscillator(), gain = audio.createGain();
    const at = audio.currentTime + i * 0.07;
    oscillator.type = 'sine'; oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, at); gain.gain.linearRampToValueAtTime(0.025, at + 0.012); gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.075);
    oscillator.connect(gain); gain.connect(audio.destination);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    oscillator.start(at); oscillator.stop(at + 0.08);
  });
}
