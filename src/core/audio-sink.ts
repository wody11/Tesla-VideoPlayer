export class AudioSink {
  private ctx: AudioContext;
  private gain: GainNode;
  constructor() {
    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
  }
  currentTimeMs() { return this.ctx.currentTime * 1000; }
  setVolume(v: number) { this.gain.gain.value = v; }
  resume() { if (this.ctx.state !== 'running') this.ctx.resume(); }
}
