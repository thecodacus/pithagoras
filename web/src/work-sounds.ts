/**
 * Quiet, synthesized work sounds for voice mode: typing while the agent runs
 * commands or edits files, and a page rustle when it reads, searches or browses.
 */
export class WorkSounds {
  private noise?: AudioBuffer;
  private typingTimer?: ReturnType<typeof setTimeout>;
  constructor(private audio: AudioContext) {}
  private noiseBuffer() {
    if (!this.noise) {
      this.noise = this.audio.createBuffer(1, this.audio.sampleRate, this.audio.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    return this.noise;
  }
  /** A band of noise shaped by an attack/decay envelope, optionally sweeping. */
  private burst(duration: number, frequency: number, level: number, sweepTo = frequency, q = 1.4) {
    if (this.audio.state !== "running") return;
    const at = this.audio.currentTime;
    const source = this.audio.createBufferSource(), filter = this.audio.createBiquadFilter(), gain = this.audio.createGain();
    source.buffer = this.noiseBuffer();
    filter.type = "bandpass"; filter.Q.value = q;
    filter.frequency.setValueAtTime(frequency, at); filter.frequency.exponentialRampToValueAtTime(sweepTo, at + duration);
    gain.gain.setValueAtTime(0, at); gain.gain.linearRampToValueAtTime(level, at + Math.min(0.004, duration / 4));
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    source.connect(filter); filter.connect(gain); gain.connect(this.audio.destination);
    source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect(); };
    source.start(at, Math.random() * 0.5); source.stop(at + duration + 0.01);
  }
  private keystroke() { this.burst(0.018 + Math.random() * 0.014, 1800 + Math.random() * 2400, 0.05 + Math.random() * 0.03); }
  /** Keystrokes in irregular runs with short pauses, like someone typing. */
  setTyping(active: boolean) {
    if (!active) { clearTimeout(this.typingTimer); this.typingTimer = undefined; return; }
    if (this.typingTimer) return;
    let run = 0;
    const next = () => {
      this.keystroke();
      run = run > 0 ? run - 1 : 4 + Math.floor(Math.random() * 14);
      this.typingTimer = setTimeout(next, run ? 55 + Math.random() * 120 : 300 + Math.random() * 700);
    };
    this.typingTimer = setTimeout(next, 150);
  }
  page() {
    this.burst(0.22, 900, 0.035, 3200, 0.8);
    setTimeout(() => this.burst(0.16, 2600, 0.02, 1400, 0.8), 120);
  }
  stop() { this.setTyping(false); }
}
