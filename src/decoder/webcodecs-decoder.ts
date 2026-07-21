// Thin WebCodecs wrapper used by the active Tesla worker pipeline.
export interface WebCodecsDecoderSink {
  onVideoFrame(frame: any): void;
  onAudioFrame(frame: any): void;
  onError(error: Error): void;
  onLog?(message: string): void;
}

export class WebCodecsDecoder {
  readonly type = 'webcodecs' as const;
  private videoDecoder?: any;
  private audioDecoder?: any;

  constructor(private sink: WebCodecsDecoderSink) {
    if (typeof (window as any).VideoDecoder !== 'function' || typeof (window as any).AudioDecoder !== 'function') {
      throw new Error('WebCodecs VideoDecoder and AudioDecoder are required.');
    }
  }

  async configureVideo(config: { codec: string; description?: ArrayBuffer; annexb?: boolean }): Promise<void> {
    this.closeVideo();
    this.videoDecoder = new (window as any).VideoDecoder({
      output: (frame: any) => this.sink.onVideoFrame(frame),
      error: (error: Error) => this.sink.onError(error)
    });
    const decoderConfig: any = {
      codec: config.codec,
      optimizeForLatency: true,
      hardwareAcceleration: 'prefer-hardware'
    };
    if (config.description && !config.annexb) decoderConfig.description = config.description;
    if (config.annexb) decoderConfig.avc = { format: 'annexb' };
    const Ctor = (window as any).VideoDecoder;
    const supported = Ctor.isConfigSupported ? await this.supportWithTimeout(Ctor, decoderConfig) : { supported: true, config: decoderConfig };
    if (!supported.supported) throw new Error(`Video codec is not supported: ${config.codec}`);
    this.videoDecoder.configure(supported.config || decoderConfig);
  }

  async configureAudio(config: { codec: string; description: ArrayBuffer; sampleRate: number; numberOfChannels: number }): Promise<void> {
    this.closeAudio();
    this.audioDecoder = new (window as any).AudioDecoder({
      output: (frame: any) => this.sink.onAudioFrame(frame),
      error: (error: Error) => this.sink.onError(error)
    });
    const decoderConfig = {
      codec: config.codec,
      description: config.description,
      sampleRate: config.sampleRate,
      numberOfChannels: config.numberOfChannels
    };
    const Ctor = (window as any).AudioDecoder;
    const supported = Ctor.isConfigSupported ? await this.supportWithTimeout(Ctor, decoderConfig) : { supported: true, config: decoderConfig };
    if (!supported.supported) throw new Error(`Audio codec is not supported: ${config.codec}`);
    this.audioDecoder.configure(supported.config || decoderConfig);
  }

  decodeVideo(sample: { data: ArrayBuffer; timestamp: number; duration?: number; key: boolean }): void {
    if (!this.videoDecoder || this.videoDecoder.state === 'closed') return;
    try {
      const chunk = new (window as any).EncodedVideoChunk({
        type: sample.key ? 'key' : 'delta',
        timestamp: sample.timestamp,
        duration: sample.duration,
        data: sample.data
      });
      this.videoDecoder.decode(chunk);
    } catch (error: any) {
      this.sink.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  decodeAudio(sample: { data: ArrayBuffer; timestamp: number; duration?: number }): void {
    if (!this.audioDecoder || this.audioDecoder.state === 'closed') return;
    try {
      const chunk = new (window as any).EncodedAudioChunk({
        type: 'key',
        timestamp: sample.timestamp,
        duration: sample.duration,
        data: sample.data
      });
      this.audioDecoder.decode(chunk);
    } catch (error: any) {
      this.sink.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  videoDecodeQueueSize(): number {
    return this.videoDecoder?.decodeQueueSize || 0;
  }

  audioDecodeQueueSize(): number {
    return this.audioDecoder?.decodeQueueSize || 0;
  }

  close(): void {
    this.closeVideo();
    this.closeAudio();
  }

  private closeVideo(): void {
    try { this.videoDecoder?.close(); } catch {}
    this.videoDecoder = undefined;
  }

  private closeAudio(): void {
    try { this.audioDecoder?.close(); } catch {}
    this.audioDecoder = undefined;
  }

  private async supportWithTimeout(Ctor: any, config: any): Promise<any> {
    return Promise.race([
      Ctor.isConfigSupported(config),
      new Promise(resolve => setTimeout(() => resolve({ supported: true, config }), 500))
    ]);
  }
}
