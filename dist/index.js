export { decodePesTimestamp, demuxTS } from './demux-ts-8c9ae7ff.js';
import './aac-adts-raw-dd9b33fc.js';

/*
 * Tesla-VideoPlayer is based on Jessibuca open source architecture.
 * Jessibuca is licensed under GPL-3.0. See THIRD_PARTY_NOTICES.md.
 */
class PlayerEvents {
    constructor() {
        this.listeners = {};
    }
    on(event, listener) {
        const list = this.listeners[event] || [];
        list.push(listener);
        this.listeners[event] = list;
        return () => this.off(event, listener);
    }
    off(event, listener) {
        const list = this.listeners[event];
        if (!list)
            return;
        const index = list.indexOf(listener);
        if (index >= 0)
            list.splice(index, 1);
    }
    emit(event, payload) {
        for (const listener of this.listeners[event] || []) {
            try {
                listener(payload);
            }
            catch {
                // External handlers must not break playback internals.
            }
        }
    }
    clear() {
        this.listeners = {};
    }
}

/*
 * Tesla-VideoPlayer is based on Jessibuca open source architecture.
 * Jessibuca is licensed under GPL-3.0. See THIRD_PARTY_NOTICES.md.
 */
class PlayerStateMachine {
    constructor() {
        this.state = 'idle';
    }
    get current() {
        return this.state;
    }
    transition(next) {
        if (this.state === 'destroyed')
            return this.state;
        this.state = next;
        return this.state;
    }
    canAcceptMedia() {
        return this.state === 'loading' || this.state === 'playing' || this.state === 'seeking';
    }
}

/*
 * Tesla-VideoPlayer is based on Jessibuca open source architecture.
 * Jessibuca is licensed under GPL-3.0. See THIRD_PARTY_NOTICES.md.
 */
class PlayerStatsTracker {
    constructor() {
        this.stats = {
            sourceType: 'unknown',
            decoderType: 'none',
            rendererType: 'none',
            audioType: 'none',
            videoTagCount: 0,
            audioSampleCount: 0,
            canvasCount: 0,
            fps: 0,
            decodedFrames: 0,
            droppedFrames: 0,
            audioQueueMs: 0,
            audioDecodedFrames: 0,
            audioScheduledSources: 0,
            audioFrameSamples: 0,
            audioContextState: 'closed',
            videoQueueLength: 0,
            currentTime: 0,
            currentTimeMs: 0,
            duration: 0,
            firstFrameTimeMs: 0,
            bitrate: 0,
            reconnectCount: 0,
            lastError: ''
        };
        this.frameTicks = 0;
        this.lastFpsAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    }
    patch(values) {
        this.stats = { ...this.stats, ...values };
    }
    markDecoded() {
        this.stats.decodedFrames += 1;
    }
    markDropped() {
        this.stats.droppedFrames += 1;
    }
    markRendered() {
        this.frameTicks += 1;
        const now = performance.now();
        if (now - this.lastFpsAt >= 1000) {
            this.stats.fps = this.frameTicks;
            this.frameTicks = 0;
            this.lastFpsAt = now;
        }
    }
    snapshot() {
        if (typeof document !== 'undefined') {
            this.patch({
                videoTagCount: document.querySelectorAll('video').length,
                canvasCount: document.querySelectorAll('canvas').length
            });
        }
        return { ...this.stats };
    }
}

/*
 * Tesla-VideoPlayer is based on Jessibuca open source architecture.
 * Jessibuca is licensed under GPL-3.0. See THIRD_PARTY_NOTICES.md.
 */
function inferSourceType(url) {
    if (/^wss?:\/\//i.test(url) && /\.flv(\?|$)/i.test(url))
        return 'ws-flv';
    if (/\.m3u8(\?|$)/i.test(url))
        return 'hls';
    if (/\.mp4(\?|$)/i.test(url) || /[?&]mime_type=video_mp4(?:&|$)/i.test(url))
        return 'mp4';
    if (/\.flv(\?|$)/i.test(url) || /^https?:\/\//i.test(url))
        return 'http-flv';
    return 'unknown';
}

/*
 * Tesla-VideoPlayer is based on Jessibuca open source architecture.
 * Jessibuca is licensed under GPL-3.0. See THIRD_PARTY_NOTICES.md.
 */
function assertNoVideoElements() {
    return document.querySelectorAll('video').length;
}
class NoVideoGuard {
    start(onViolation) {
        this.stop();
        const check = () => {
            const count = assertNoVideoElements();
            if (count > 0)
                onViolation(count);
        };
        check();
        this.observer = new MutationObserver(check);
        this.observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    stop() {
        this.observer?.disconnect();
        this.observer = undefined;
    }
}

// Maps media timestamps to AudioContext time so video can follow audio.
class AudioClock {
    reset() {
        this.baseMediaUs = undefined;
        this.baseContextTime = undefined;
    }
    bind(mediaUs, contextTime) {
        if (this.baseMediaUs === undefined) {
            this.baseMediaUs = mediaUs;
            this.baseContextTime = contextTime;
        }
    }
    mediaTimeUs(contextTime) {
        if (this.baseMediaUs === undefined || this.baseContextTime === undefined)
            return undefined;
        return this.baseMediaUs + (contextTime - this.baseContextTime) * 1000000;
    }
    targetContextTime(mediaUs) {
        if (this.baseMediaUs === undefined || this.baseContextTime === undefined)
            return undefined;
        return this.baseContextTime + (mediaUs - this.baseMediaUs) / 1000000;
    }
}

// Schedules decoded AudioData through WebAudio without using media elements.
class WebAudioPlayer {
    constructor() {
        this.clock = new AudioClock();
        this.scheduledUntil = 0;
        this.sources = new Set();
        this.targetQueueMs = 1500;
        this.hardResetQueueMs = 7000;
        this.enqueuedFrames = 0;
        this.lastFrameSamples = 0;
        this.lastTimestampUs = 0;
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor)
            throw new Error('WebAudio is not available.');
        this.context = new Ctor();
        this.gain = this.context.createGain();
        this.gain.gain.value = 1;
        this.gain.connect(this.context.destination);
    }
    async resume() {
        if (this.context.state !== 'running')
            await this.context.resume();
    }
    pause() {
        this.context.suspend().catch(() => undefined);
    }
    setVolume(value) {
        const volume = Math.max(0, Math.min(1, Number(value) || 0));
        this.gain.gain.setValueAtTime(volume, this.context.currentTime);
    }
    setMaxQueueMs(value) {
        this.targetQueueMs = Math.max(300, Math.min(5000, Number(value) || 1500));
        this.hardResetQueueMs = Math.max(this.targetQueueMs * 2, this.targetQueueMs + 1000);
    }
    enqueue(frame) {
        if (this.context.state !== 'running')
            this.context.resume().catch(() => undefined);
        const channels = frame.numberOfChannels || 2;
        const frames = frame.numberOfFrames || 0;
        const sampleRate = frame.sampleRate || this.context.sampleRate;
        const timestamp = typeof frame.timestamp === 'number' ? frame.timestamp : 0;
        this.enqueuedFrames += 1;
        this.lastFrameSamples = frames;
        this.lastTimestampUs = timestamp;
        if (this.queuedMs() > this.hardResetQueueMs) {
            this.stopScheduledSources();
            this.clock.reset();
            this.scheduledUntil = this.context.currentTime + this.targetQueueMs / 1000;
        }
        this.clock.bind(timestamp, Math.max(this.context.currentTime + this.targetQueueMs / 1000, this.scheduledUntil || 0));
        const audioBuffer = this.context.createBuffer(channels, frames, sampleRate);
        for (let ch = 0; ch < channels; ch++) {
            const data = new Float32Array(frames);
            try {
                frame.copyTo(data, { planeIndex: ch });
            }
            catch {
                frame.copyTo(data);
            }
            audioBuffer.copyToChannel(data, ch);
        }
        const source = this.context.createBufferSource();
        source.buffer = audioBuffer;
        const queueMs = this.queuedMs();
        const catchupRate = queueMs > this.targetQueueMs
            ? Math.min(1.12, 1 + ((queueMs - this.targetQueueMs) / Math.max(this.targetQueueMs, 1)) * 0.06)
            : 1;
        source.playbackRate.setValueAtTime(catchupRate, this.context.currentTime);
        source.connect(this.gain);
        const target = this.clock.targetContextTime(timestamp);
        const when = Math.max(this.context.currentTime + 0.01, target ?? this.scheduledUntil ?? this.context.currentTime);
        source.start(when);
        this.scheduledUntil = Math.max(this.scheduledUntil, when + audioBuffer.duration / catchupRate);
        this.sources.add(source);
        source.onended = () => this.sources.delete(source);
    }
    queuedMs() {
        return Math.max(0, (this.scheduledUntil - this.context.currentTime) * 1000);
    }
    currentTimeMs() {
        const mediaUs = this.clock.mediaTimeUs(this.context.currentTime);
        return mediaUs === undefined ? 0 : mediaUs / 1000;
    }
    isRunning() {
        return this.context.state === 'running';
    }
    delayUntilMediaTimeMs(mediaUs) {
        const target = this.clock.targetContextTime(mediaUs);
        if (target === undefined)
            return undefined;
        return (target - this.context.currentTime) * 1000;
    }
    diagnostics() {
        return {
            contextState: this.context.state,
            enqueuedFrames: this.enqueuedFrames,
            scheduledSources: this.sources.size,
            lastFrameSamples: this.lastFrameSamples,
            lastTimestampUs: this.lastTimestampUs
        };
    }
    close() {
        this.stopScheduledSources();
        this.clock.reset();
        this.context.close().catch(() => undefined);
    }
    stopScheduledSources() {
        for (const source of this.sources) {
            try {
                source.stop();
            }
            catch { }
            try {
                source.disconnect();
            }
            catch { }
        }
        this.sources.clear();
    }
}

class WebCodecsDecoder {
    constructor(sink) {
        this.sink = sink;
        this.type = 'webcodecs';
        if (typeof window.VideoDecoder !== 'function' || typeof window.AudioDecoder !== 'function') {
            throw new Error('WebCodecs VideoDecoder and AudioDecoder are required.');
        }
    }
    async configureVideo(config) {
        this.closeVideo();
        this.videoDecoder = new window.VideoDecoder({
            output: (frame) => this.sink.onVideoFrame(frame),
            error: (error) => this.sink.onError(error)
        });
        const decoderConfig = {
            codec: config.codec,
            optimizeForLatency: true,
            hardwareAcceleration: 'prefer-hardware'
        };
        if (config.description && !config.annexb)
            decoderConfig.description = config.description;
        if (config.annexb)
            decoderConfig.avc = { format: 'annexb' };
        const Ctor = window.VideoDecoder;
        const supported = Ctor.isConfigSupported ? await this.supportWithTimeout(Ctor, decoderConfig) : { supported: true, config: decoderConfig };
        if (!supported.supported)
            throw new Error(`Video codec is not supported: ${config.codec}`);
        this.videoDecoder.configure(supported.config || decoderConfig);
    }
    async configureAudio(config) {
        this.closeAudio();
        this.audioDecoder = new window.AudioDecoder({
            output: (frame) => this.sink.onAudioFrame(frame),
            error: (error) => this.sink.onError(error)
        });
        const decoderConfig = {
            codec: config.codec,
            description: config.description,
            sampleRate: config.sampleRate,
            numberOfChannels: config.numberOfChannels
        };
        const Ctor = window.AudioDecoder;
        const supported = Ctor.isConfigSupported ? await this.supportWithTimeout(Ctor, decoderConfig) : { supported: true, config: decoderConfig };
        if (!supported.supported)
            throw new Error(`Audio codec is not supported: ${config.codec}`);
        this.audioDecoder.configure(supported.config || decoderConfig);
    }
    decodeVideo(sample) {
        if (!this.videoDecoder || this.videoDecoder.state === 'closed')
            return;
        try {
            const chunk = new window.EncodedVideoChunk({
                type: sample.key ? 'key' : 'delta',
                timestamp: sample.timestamp,
                duration: sample.duration,
                data: sample.data
            });
            this.videoDecoder.decode(chunk);
        }
        catch (error) {
            this.sink.onError(error instanceof Error ? error : new Error(String(error)));
        }
    }
    decodeAudio(sample) {
        if (!this.audioDecoder || this.audioDecoder.state === 'closed')
            return;
        try {
            const chunk = new window.EncodedAudioChunk({
                type: 'key',
                timestamp: sample.timestamp,
                duration: sample.duration,
                data: sample.data
            });
            this.audioDecoder.decode(chunk);
        }
        catch (error) {
            this.sink.onError(error instanceof Error ? error : new Error(String(error)));
        }
    }
    videoDecodeQueueSize() {
        return this.videoDecoder?.decodeQueueSize || 0;
    }
    audioDecodeQueueSize() {
        return this.audioDecoder?.decodeQueueSize || 0;
    }
    close() {
        this.closeVideo();
        this.closeAudio();
    }
    closeVideo() {
        try {
            this.videoDecoder?.close();
        }
        catch { }
        this.videoDecoder = undefined;
    }
    closeAudio() {
        try {
            this.audioDecoder?.close();
        }
        catch { }
        this.audioDecoder = undefined;
    }
    async supportWithTimeout(Ctor, config) {
        return Promise.race([
            Ctor.isConfigSupported(config),
            new Promise(resolve => setTimeout(() => resolve({ supported: true, config }), 500))
        ]);
    }
}

// Canvas 2D renderer for WebCodecs VideoFrame output.
class CanvasRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.type = 'canvas2d';
        const ctx = canvas.getContext('2d');
        if (!ctx)
            throw new Error('Canvas 2D context is not available.');
        this.ctx = ctx;
    }
    draw(frame) {
        this.resize(frame.displayWidth || frame.codedWidth, frame.displayHeight || frame.codedHeight);
        this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
    }
    clear() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    destroy() {
        this.clear();
    }
    resize(width, height) {
        if (width && height && (this.canvas.width !== width || this.canvas.height !== height)) {
            this.canvas.width = width;
            this.canvas.height = height;
        }
    }
}

// WebGL renderer that uploads WebCodecs VideoFrame objects as RGBA textures.
class WebGLRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.type = 'webgl';
        this.texture = null;
        this.program = null;
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (!gl)
            throw new Error('WebGL context is not available.');
        this.gl = gl;
        this.init();
    }
    draw(frame) {
        const width = frame.displayWidth || frame.codedWidth;
        const height = frame.displayHeight || frame.codedHeight;
        if (width && height && (this.canvas.width !== width || this.canvas.height !== height)) {
            this.canvas.width = width;
            this.canvas.height = height;
        }
        const gl = this.gl;
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    clear() {
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    }
    destroy() {
        if (this.texture)
            this.gl.deleteTexture(this.texture);
        if (this.program)
            this.gl.deleteProgram(this.program);
        this.texture = null;
        this.program = null;
    }
    init() {
        const gl = this.gl;
        const vertexSource = [
            'attribute vec2 a_pos;',
            'attribute vec2 a_uv;',
            'varying vec2 v_uv;',
            'void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); v_uv = a_uv; }'
        ].join('\n');
        const fragmentSource = [
            'precision mediump float;',
            'varying vec2 v_uv;',
            'uniform sampler2D u_tex;',
            'void main(){ gl_FragColor = texture2D(u_tex, v_uv); }'
        ].join('\n');
        const vertex = this.compile(gl.VERTEX_SHADER, vertexSource);
        const fragment = this.compile(gl.FRAGMENT_SHADER, fragmentSource);
        const program = gl.createProgram();
        if (!program)
            throw new Error('Failed to create WebGL program.');
        gl.attachShader(program, vertex);
        gl.attachShader(program, fragment);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error(gl.getProgramInfoLog(program) || 'Failed to link WebGL program.');
        }
        gl.useProgram(program);
        this.program = program;
        const vertices = new Float32Array([
            -1, -1, 0, 0,
            1, -1, 1, 0,
            -1, 1, 0, 1,
            1, 1, 1, 1
        ]);
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
        const pos = gl.getAttribLocation(program, 'a_pos');
        const uv = gl.getAttribLocation(program, 'a_uv');
        gl.enableVertexAttribArray(pos);
        gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 16, 0);
        gl.enableVertexAttribArray(uv);
        gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 16, 8);
        this.texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.uniform1i(gl.getUniformLocation(program, 'u_tex'), 0);
    }
    compile(type, source) {
        const shader = this.gl.createShader(type);
        if (!shader)
            throw new Error('Failed to create WebGL shader.');
        this.gl.shaderSource(shader, source);
        this.gl.compileShader(shader);
        if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
            throw new Error(this.gl.getShaderInfoLog(shader) || 'Failed to compile WebGL shader.');
        }
        return shader;
    }
}

/*
 * Tesla-VideoPlayer is based on Jessibuca open source architecture.
 * Jessibuca is licensed under GPL-3.0. See THIRD_PARTY_NOTICES.md.
 */
function detectCapability(canvas, requireWebCodecs = true) {
    const webCodecsVideo = typeof globalThis.VideoDecoder === 'function';
    const webCodecsAudio = typeof globalThis.AudioDecoder === 'function';
    const webAudio = typeof globalThis.AudioContext === 'function' || typeof globalThis.webkitAudioContext === 'function';
    const wasm = typeof WebAssembly !== 'undefined';
    let webGL = false;
    try {
        const probe = canvas || document.createElement('canvas');
        webGL = !!(probe.getContext('webgl') || probe.getContext('experimental-webgl'));
    }
    catch {
        webGL = false;
    }
    const supported = webAudio && (!requireWebCodecs || (webCodecsVideo && webCodecsAudio));
    const reason = supported ? undefined : 'This no-video path requires WebAudio and WebCodecs, or an enabled WASM decoder fallback.';
    return { webCodecsVideo, webCodecsAudio, webAudio, webGL, wasm, supported, reason };
}

const PLAYBACK_PRESETS = {
    'low-latency': {
        preset: 'low-latency',
        audioMaxQueueMs: 900,
        decodeBatchSize: 10,
        maxRenderQueue: 80,
        lateDropMs: 160,
        liveStartSegmentCount: 1,
        liveSegmentBatch: 1
    },
    balanced: {
        preset: 'balanced',
        audioMaxQueueMs: 1500,
        decodeBatchSize: 8,
        maxRenderQueue: 120,
        lateDropMs: 240,
        liveStartSegmentCount: 1,
        liveSegmentBatch: 1
    },
    smooth: {
        preset: 'smooth',
        audioMaxQueueMs: 2600,
        decodeBatchSize: 6,
        maxRenderQueue: 180,
        lateDropMs: 420,
        liveStartSegmentCount: 2,
        liveSegmentBatch: 1
    }
};

class HlsWebCodecsEngine {
    constructor(options) {
        this.options = options;
        this.events = new PlayerEvents();
        this.state = new PlayerStateMachine();
        this.stats = new PlayerStatsTracker();
        this.guard = new NoVideoGuard();
        this.firstFrameStart = 0;
        this.firstFrameSeen = false;
        this.videoQueueLength = 0;
        this.stopped = false;
        this.paused = false;
        this.pausedAtMs = 0;
        this.sourceType = 'hls';
        this.currentUrl = '';
        this.mp4PullOutstanding = 0;
        this.videoConfigured = false;
        this.audioConfigured = false;
        this.seenKeyFrame = false;
        this.pendingVideoSamples = [];
        this.pendingAudioSamples = [];
        this.renderQueue = [];
        this.settings = {
            fitMode: 'contain',
            preset: 'balanced',
            liveStartSegmentCount: 1,
            liveSegmentBatch: 1,
            audioMaxQueueMs: 1500,
            decodeBatchSize: 8,
            maxRenderQueue: 120,
            lateDropMs: 240
        };
        this.on = this.events.on.bind(this.events);
        this.canvas = document.createElement('canvas');
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.maxWidth = '100%';
        this.canvas.style.maxHeight = '100%';
        this.canvas.style.position = 'absolute';
        this.canvas.style.inset = '0';
        this.canvas.style.display = 'block';
        this.canvas.style.objectFit = 'contain';
        this.canvas.style.background = '#000';
        options.container.appendChild(this.canvas);
        this.updateSettings(options);
        this.renderer = this.createRenderer(options.renderer || 'webgl');
        this.stats.patch({ rendererType: this.renderer.type });
        this.stats.patch({ sourceType: 'hls', audioType: 'webaudio' });
        this.guard.start(count => this.fail(new Error(`video elements are forbidden, found ${count}.`)));
    }
    async play(url, sourceType = 'hls', startTime = 0) {
        if (!url)
            throw new Error('Playback URL is required.');
        this.stop();
        this.stopped = false;
        this.paused = false;
        this.sourceType = sourceType;
        this.currentUrl = url;
        this.mp4PullOutstanding = 0;
        this.firstFrameStart = performance.now();
        this.firstFrameSeen = false;
        this.state.transition('loading');
        this.events.emit('state', this.state.current);
        const capability = detectCapability(this.canvas);
        if (!capability.supported) {
            this.stats.patch({ decoderType: 'unsupported' });
            throw new Error(capability.reason || 'Required browser capability is not available.');
        }
        this.audio = new WebAudioPlayer();
        this.audio.setMaxQueueMs(this.settings.audioMaxQueueMs);
        this.audio.resume().catch(error => {
            this.events.emit('log', `AudioContext resume is pending or blocked: ${error?.message || error}`);
        });
        this.decoder = new WebCodecsDecoder({
            onVideoFrame: frame => this.handleVideoFrame(frame),
            onAudioFrame: frame => this.handleAudioFrame(frame),
            onError: error => this.fail(error)
        });
        this.stats.patch({ decoderType: 'webcodecs' });
        this.worker = new Worker(this.options.workerUrl || new URL('./worker-entry.js', import.meta.url), { type: 'module' });
        this.worker.onmessage = event => this.handleWorkerEvent(event.data);
        this.worker.onerror = event => this.fail(new Error(event.message || 'HTTP-FLV worker failed.'));
        if (sourceType === 'mp4')
            this.worker.postMessage({ type: 'open-mp4', url, startTime });
        else if (sourceType === 'hls')
            this.worker.postMessage({
                type: 'open-hls', url,
                liveStartSegmentCount: this.settings.liveStartSegmentCount,
                liveSegmentBatch: this.settings.liveSegmentBatch,
                startTime
            });
        else
            this.worker.postMessage({ type: sourceType === 'ws-flv' ? 'open-ws-flv' : 'open-http-flv', url });
    }
    pause() {
        if (this.paused || this.stopped)
            return;
        this.paused = true;
        this.pausedAtMs = performance.now();
        this.worker?.postMessage({ type: 'pause' });
        this.audio?.pause();
        this.state.transition('paused');
        this.events.emit('state', this.state.current);
    }
    async resume() {
        if (!this.paused || this.stopped)
            return;
        const pausedDuration = performance.now() - this.pausedAtMs;
        if (this.videoWallClockBaseMs !== undefined)
            this.videoWallClockBaseMs += pausedDuration;
        this.paused = false;
        await this.audio?.resume();
        this.worker?.postMessage({ type: 'resume' });
        this.state.transition('playing');
        this.events.emit('state', this.state.current);
        if (this.pendingVideoSamples.length || this.pendingAudioSamples.length)
            this.ensureDecodePump();
        if (this.renderQueue.length)
            this.ensureRenderLoop();
    }
    async seek(time) {
        if (this.sourceType !== 'mp4' && this.sourceType !== 'hls')
            throw new Error('seek() is available for MP4 and HLS on-demand playback only.');
        this.state.transition('seeking');
        this.events.emit('state', this.state.current);
        await this.play(this.currentUrl, this.sourceType, Math.max(0, Number(time) || 0));
    }
    stop() {
        this.stopped = true;
        this.paused = false;
        this.worker?.postMessage({ type: 'stop' });
        this.worker?.terminate();
        this.worker = undefined;
        this.decoder?.close();
        this.decoder = undefined;
        this.audio?.close();
        this.audio = undefined;
        this.videoQueueLength = 0;
        this.videoConfigured = false;
        this.audioConfigured = false;
        this.seenKeyFrame = false;
        this.pendingVideoSamples = [];
        this.pendingAudioSamples = [];
        this.mp4PullOutstanding = 0;
        this.videoWallClockBaseUs = undefined;
        this.videoWallClockBaseMs = undefined;
        this.clearDecodePump();
        this.clearRenderQueue();
        try {
            this.renderer.clear();
        }
        catch { }
        this.state.transition('stopped');
        this.events.emit('state', this.state.current);
    }
    destroy() {
        this.stop();
        this.guard.stop();
        this.events.clear();
        this.renderer.destroy();
        this.canvas.remove();
        this.state.transition('destroyed');
    }
    setVolume(value) {
        this.audio?.setVolume(value);
    }
    getStats() {
        const audioDiagnostics = this.audio?.diagnostics();
        this.stats.patch({
            audioQueueMs: this.audio?.queuedMs() || 0,
            audioDecodedFrames: audioDiagnostics?.enqueuedFrames || 0,
            audioScheduledSources: audioDiagnostics?.scheduledSources || 0,
            audioFrameSamples: audioDiagnostics?.lastFrameSamples || 0,
            audioContextState: audioDiagnostics?.contextState || 'closed',
            videoQueueLength: this.videoQueueLength,
            currentTimeMs: this.audio?.currentTimeMs() || 0
        });
        return this.stats.snapshot();
    }
    setRenderer(type) {
        this.renderer.destroy();
        this.renderer = this.createRenderer(type);
        this.stats.patch({ rendererType: this.renderer.type });
    }
    updateSettings(values) {
        if (values.preset) {
            const preset = PLAYBACK_PRESETS[values.preset];
            if (preset) {
                this.settings = { ...this.settings, ...preset };
                this.audio?.setMaxQueueMs(this.settings.audioMaxQueueMs);
            }
        }
        if (values.fitMode) {
            this.settings.fitMode = values.fitMode;
            this.canvas.style.objectFit = values.fitMode === 'fill' ? 'fill' : values.fitMode;
        }
        if (typeof values.liveStartSegmentCount === 'number')
            this.settings.liveStartSegmentCount = Math.max(1, Math.min(3, values.liveStartSegmentCount));
        if (typeof values.liveSegmentBatch === 'number')
            this.settings.liveSegmentBatch = Math.max(1, Math.min(3, values.liveSegmentBatch));
        if (typeof values.audioMaxQueueMs === 'number') {
            this.settings.audioMaxQueueMs = Math.max(300, Math.min(5000, values.audioMaxQueueMs));
            this.audio?.setMaxQueueMs(this.settings.audioMaxQueueMs);
        }
        if (typeof values.decodeBatchSize === 'number')
            this.settings.decodeBatchSize = Math.max(1, Math.min(24, values.decodeBatchSize));
        if (typeof values.maxRenderQueue === 'number')
            this.settings.maxRenderQueue = Math.max(30, Math.min(240, values.maxRenderQueue));
        if (typeof values.lateDropMs === 'number')
            this.settings.lateDropMs = Math.max(80, Math.min(1000, values.lateDropMs));
    }
    createRenderer(type) {
        if (type === 'canvas2d')
            return new CanvasRenderer(this.canvas);
        try {
            return new WebGLRenderer(this.canvas);
        }
        catch {
            return new CanvasRenderer(this.canvas);
        }
    }
    handleWorkerEvent(message) {
        if (this.stopped)
            return;
        try {
            if (message.type === 'stream-open') {
                this.events.emit('log', 'Stream opened.');
            }
            else if (message.type === 'stream-end') {
                this.events.emit('log', 'Stream ended.');
            }
            else if (message.type === 'media-info') {
                this.stats.patch({ duration: message.duration });
                this.events.emit('log', `Media info: ${message.videoCodec || 'no video'} / ${message.audioCodec || 'no audio'}, ${message.duration.toFixed(2)}s.`);
                this.ensureMp4Pull();
            }
            else if (message.type === 'video-config') {
                this.events.emit('log', `Video config received: ${message.codec}${message.annexb ? ' annexb' : ''}`);
                this.decoder?.configureVideo(message).then(() => {
                    this.videoConfigured = true;
                    this.events.emit('log', `VideoDecoder configured, queued video samples: ${this.pendingVideoSamples.length}.`);
                    this.ensureDecodePump();
                }).catch(error => this.fail(error));
            }
            else if (message.type === 'audio-config') {
                this.events.emit('log', `Audio config received: ${message.codec} ${message.sampleRate}Hz/${message.numberOfChannels}ch`);
                this.decoder?.configureAudio(message).then(() => {
                    this.audioConfigured = true;
                    this.ensureDecodePump();
                }).catch(error => this.fail(error));
            }
            else if (message.type === 'video-sample') {
                if (this.sourceType === 'mp4')
                    this.mp4PullOutstanding = Math.max(0, this.mp4PullOutstanding - 1);
                if (!this.seenKeyFrame) {
                    if (!message.key)
                        return;
                    this.seenKeyFrame = true;
                }
                this.videoQueueLength += 1;
                this.pendingVideoSamples.push(message);
                if (this.videoConfigured)
                    this.ensureDecodePump();
            }
            else if (message.type === 'audio-sample') {
                if (this.sourceType === 'mp4')
                    this.mp4PullOutstanding = Math.max(0, this.mp4PullOutstanding - 1);
                this.pendingAudioSamples.push(message);
                if (this.audioConfigured)
                    this.ensureDecodePump();
            }
            else if (message.type === 'stats') {
                this.stats.patch({ videoTagCount: message.videoTagCount, audioSampleCount: message.audioTagCount });
            }
            else if (message.type === 'log') {
                this.events.emit('log', message.message);
            }
            else if (message.type === 'error') {
                this.fail(new Error(message.message));
            }
        }
        catch (error) {
            this.fail(error instanceof Error ? error : new Error(String(error)));
        }
    }
    handleVideoFrame(frame) {
        const timestamp = typeof frame.timestamp === 'number' ? frame.timestamp : 0;
        if (this.videoWallClockBaseUs === undefined) {
            this.videoWallClockBaseUs = timestamp;
            this.videoWallClockBaseMs = performance.now();
        }
        this.stats.markDecoded();
        this.renderQueue.push({ frame, timestamp });
        this.renderQueue.sort((a, b) => a.timestamp - b.timestamp);
        while (this.renderQueue.length > 180) {
            const old = this.renderQueue.shift();
            try {
                old?.frame.close();
            }
            catch { }
            this.videoQueueLength = Math.max(0, this.videoQueueLength - 1);
            this.stats.markDropped();
        }
        this.ensureRenderLoop();
    }
    handleAudioFrame(frame) {
        try {
            this.audio?.enqueue(frame);
        }
        finally {
            frame.close();
        }
    }
    fail(error) {
        this.state.transition('error');
        this.events.emit('state', this.state.current);
        this.events.emit('error', error);
    }
    ensureRenderLoop() {
        if (this.renderLoopId !== undefined)
            return;
        this.renderLoopId = window.setTimeout(() => this.renderTick(), 8);
    }
    ensureDecodePump() {
        if (this.decodePumpId !== undefined)
            return;
        this.decodePumpId = window.setTimeout(() => this.decodeTick(), 0);
    }
    decodeTick() {
        this.decodePumpId = undefined;
        if (this.stopped || this.paused)
            return;
        let videoBudget = this.settings.decodeBatchSize;
        while (this.videoConfigured && videoBudget > 0 && this.pendingVideoSamples.length > 0 && this.renderQueue.length < 150) {
            const sample = this.pendingVideoSamples.shift();
            this.decoder?.decodeVideo(sample);
            videoBudget -= 1;
        }
        // Audio has its own budget. Sharing the video budget starves AAC whenever
        // a live segment leaves a persistent video backlog.
        let audioBudget = Math.max(4, this.settings.decodeBatchSize * 2);
        while (this.audioConfigured && audioBudget > 0 && this.pendingAudioSamples.length > 0
            && (this.audio?.queuedMs() || 0) < this.settings.audioMaxQueueMs * 1.25
            && (this.decoder?.audioDecodeQueueSize() || 0) < 32) {
            this.decoder?.decodeAudio(this.pendingAudioSamples.shift());
            audioBudget -= 1;
        }
        this.ensureMp4Pull();
        if ((this.videoConfigured && this.pendingVideoSamples.length > 0 && this.renderQueue.length < 150)
            || (this.audioConfigured && this.pendingAudioSamples.length > 0
                && (this.audio?.queuedMs() || 0) < this.settings.audioMaxQueueMs * 1.25
                && (this.decoder?.audioDecodeQueueSize() || 0) < 32)) {
            this.ensureDecodePump();
        }
        else if (this.pendingAudioSamples.length > 0) {
            this.decodePumpId = window.setTimeout(() => this.decodeTick(), 25);
        }
    }
    renderTick() {
        this.renderLoopId = undefined;
        if (this.stopped) {
            this.clearRenderQueue();
            return;
        }
        if (this.paused)
            return;
        while (this.renderQueue.length > 0 && this.videoDelayMs(this.renderQueue[0].timestamp) < -this.settings.lateDropMs) {
            const late = this.renderQueue.shift();
            try {
                late?.frame.close();
            }
            catch { }
            this.videoQueueLength = Math.max(0, this.videoQueueLength - 1);
            this.stats.markDropped();
        }
        if (this.renderQueue.length > 0) {
            const delayMs = this.videoDelayMs(this.renderQueue[0].timestamp);
            if ((!this.firstFrameSeen && delayMs > 250) || delayMs <= 12) {
                const current = this.renderQueue.shift();
                this.drawVideoFrame(current.frame);
            }
        }
        while (this.renderQueue.length > this.settings.maxRenderQueue) {
            const old = this.renderQueue.shift();
            try {
                old?.frame.close();
            }
            catch { }
            this.videoQueueLength = Math.max(0, this.videoQueueLength - 1);
            this.stats.markDropped();
        }
        if (this.renderQueue.length > 0)
            this.ensureRenderLoop();
        this.ensureMp4Pull();
    }
    videoDelayMs(timestamp) {
        const audioDelay = this.audioConfigured ? this.audio?.delayUntilMediaTimeMs(timestamp) : undefined;
        if (audioDelay !== undefined)
            return audioDelay;
        if (this.videoWallClockBaseUs !== undefined && this.videoWallClockBaseMs !== undefined) {
            return this.videoWallClockBaseMs + (timestamp - this.videoWallClockBaseUs) / 1000 - performance.now();
        }
        return 0;
    }
    drawVideoFrame(frame) {
        try {
            this.renderer.draw(frame);
            this.stats.markRendered();
            if (!this.firstFrameSeen) {
                this.firstFrameSeen = true;
                const firstFrameTimeMs = Math.round(performance.now() - this.firstFrameStart);
                this.stats.patch({ firstFrameTimeMs });
                this.state.transition('playing');
                this.events.emit('state', this.state.current);
                this.events.emit('firstFrame', firstFrameTimeMs);
            }
        }
        finally {
            this.videoQueueLength = Math.max(0, this.videoQueueLength - 1);
            try {
                frame.close();
            }
            catch { }
        }
    }
    clearRenderQueue() {
        if (this.renderLoopId !== undefined) {
            clearTimeout(this.renderLoopId);
            this.renderLoopId = undefined;
        }
        for (const item of this.renderQueue) {
            try {
                item.frame.close();
            }
            catch { }
        }
        this.renderQueue = [];
    }
    clearDecodePump() {
        if (this.decodePumpId !== undefined) {
            clearTimeout(this.decodePumpId);
            this.decodePumpId = undefined;
        }
    }
    ensureMp4Pull() {
        if (this.sourceType !== 'mp4' || this.stopped || this.paused || !this.worker)
            return;
        const buffered = this.pendingVideoSamples.length + this.pendingAudioSamples.length + this.renderQueue.length;
        if (buffered + this.mp4PullOutstanding >= 320 || (this.audio?.queuedMs() || 0) > this.settings.audioMaxQueueMs * 1.5)
            return;
        const count = 320 - buffered - this.mp4PullOutstanding;
        this.mp4PullOutstanding += count;
        this.worker.postMessage({ type: 'pull', count });
    }
}

/*
 * h265web.js integration layer.
 *
 * The npm package h265web.js@2.2.2 is vendored under vendor/h265webjs, but its
 * published package does not include the actual dist/h265webjs.js runtime or
 * wasm decoder assets referenced by its README. This engine therefore exposes
 * the integration contract and fails with a clear error until those assets are
 * supplied.
 */
let h265webLoader;
function loadScript(url) {
    if (window.new265webjs)
        return Promise.resolve();
    if (h265webLoader)
        return h265webLoader;
    h265webLoader = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = url;
        script.async = true;
        script.onload = () => window.new265webjs ? resolve() : reject(new Error('h265web.js loaded but window.new265webjs is missing.'));
        script.onerror = () => reject(new Error(`Failed to load h265web.js runtime: ${url}. Expected vendored asset dist/h265webjs.js is missing.`));
        document.head.appendChild(script);
    });
    return h265webLoader;
}
class H265WebEngine {
    constructor(container, options) {
        this.container = container;
        this.options = options;
    }
    async play(url) {
        const runtime = this.options.h265webUrl || new URL('./h265webjs.js', import.meta.url).href;
        await loadScript(runtime);
        if (!window.new265webjs)
            throw new Error('h265web.js runtime is unavailable.');
        this.container.innerHTML = '';
        const id = this.container.id || `tesla-h265-${Math.random().toString(16).slice(2)}`;
        this.container.id = id;
        this.instance = window.new265webjs(url, {
            player: id,
            width: this.container.clientWidth || 960,
            height: this.container.clientHeight || 540,
            token: '',
            extInfo: {}
        });
        this.instance.do?.();
        this.instance.play?.();
    }
    pause() { this.instance?.pause?.(); }
    stop() { this.instance?.pause?.(); }
    destroy() {
        this.instance?.release?.();
        this.instance?.close?.();
        this.instance = undefined;
    }
    setVolume(volume) { this.instance?.setVoice?.(volume); }
    seek(time) { this.instance?.seek?.(time); }
}

/*
 * Tesla-VideoPlayer runtime now delegates playback to Jessibuca OSS directly.
 * Jessibuca is licensed under GPL-3.0. See THIRD_PARTY_NOTICES.md.
 */
let jessibucaLoader;
function loadJessibuca(scriptUrl = new URL('./jessibuca.js', import.meta.url).href) {
    if (window.Jessibuca)
        return Promise.resolve();
    if (jessibucaLoader)
        return jessibucaLoader;
    jessibucaLoader = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = scriptUrl;
        script.async = true;
        script.onload = () => window.Jessibuca ? resolve() : reject(new Error('Jessibuca loaded but global constructor is missing.'));
        script.onerror = () => reject(new Error(`Failed to load Jessibuca runtime: ${scriptUrl}`));
        document.head.appendChild(script);
    });
    return jessibucaLoader;
}
class TeslaPlayer {
    constructor(containerOrOptions, maybeOptions = {}) {
        var _a, _b;
        this.containerOrOptions = containerOrOptions;
        this.events = new PlayerEvents();
        this.state = new PlayerStateMachine();
        this.stats = new PlayerStatsTracker();
        this.guard = new NoVideoGuard();
        this.activeEngine = 'none';
        this.url = '';
        this.sourceType = 'unknown';
        this.firstFrameStart = 0;
        this.firstFrameSeen = false;
        this.volume = 1;
        this.handlers = [];
        this.on = this.events.on.bind(this.events);
        this.off = this.events.off.bind(this.events);
        this.options = containerOrOptions instanceof HTMLElement
            ? { ...maybeOptions, container: containerOrOptions }
            : containerOrOptions;
        if (!this.options.container)
            throw new Error('createTeslaPlayer requires a container element.');
        (_a = this.options.container.style).position || (_a.position = 'relative');
        (_b = this.options.container.style).background || (_b.background = '#000');
        this.guard.start(count => this.fail(new Error(`video elements are forbidden, found ${count}.`)));
        this.stats.patch({
            decoderType: 'wasm',
            rendererType: 'canvas2d',
            audioType: 'webaudio'
        });
        if (this.options.url)
            this.load(this.options.url, this.options);
    }
    load(url, options = {}) {
        this.url = url;
        this.options = { ...this.options, ...options };
        this.sourceType = options.sourceType || inferSourceType(url);
        this.stats.patch({ sourceType: this.sourceType, lastError: '' });
    }
    async play(url, options = {}) {
        if (url)
            this.load(url, options);
        if (!this.url)
            throw new Error('Playback URL is required.');
        if (this.sourceType === 'hls' || this.sourceType === 'mp4') {
            await this.playWithHlsEngine();
            return;
        }
        if (this.sourceType === 'h265') {
            if (!this.options.enableH265Web) {
                this.fail(new Error('h265web.js is studied but disabled by default for Tesla no-video mode. Set enableH265Web only after supplying its missing runtime/wasm assets.'));
                return;
            }
            await this.playWithH265WebEngine();
            return;
        }
        await this.ensureJessibuca();
        this.firstFrameStart = performance.now();
        this.firstFrameSeen = false;
        this.state.transition('loading');
        this.events.emit('state', this.state.current);
        await this.jess.play(this.url);
    }
    pause() {
        if (this.activeEngine === 'hls')
            this.hls?.pause();
        else if (this.activeEngine === 'h265web')
            this.h265?.pause();
        else
            this.jess?.pause().catch(error => this.fail(error));
        this.state.transition('paused');
        this.events.emit('state', this.state.current);
    }
    async resume() {
        if (this.activeEngine === 'hls')
            await this.hls?.resume();
        else if (this.activeEngine === 'h265web')
            await this.h265?.play(this.url);
        else
            await this.jess?.play();
    }
    stop() {
        if (this.activeEngine === 'hls')
            this.hls?.stop();
        else if (this.activeEngine === 'h265web')
            this.h265?.stop();
        else
            this.jess?.close();
        this.state.transition('stopped');
        this.events.emit('state', this.state.current);
    }
    destroy() {
        this.jess?.destroy();
        this.hls?.destroy();
        this.h265?.destroy();
        this.jess = undefined;
        this.hls = undefined;
        this.h265 = undefined;
        this.handlers = [];
        this.guard.stop();
        this.events.clear();
        this.state.transition('destroyed');
    }
    seek(time) {
        if (this.activeEngine === 'hls' && (this.sourceType === 'mp4' || this.sourceType === 'hls')) {
            this.hls?.seek(time).catch(error => this.fail(error instanceof Error ? error : new Error(String(error))));
            return;
        }
        this.fail(new Error(`seek() is only supported for MP4/HLS on-demand playback; current source is ${this.sourceType}.`));
    }
    setVolume(volume) {
        this.volume = Math.max(0, Math.min(1, Number(volume) || 0));
        this.jess?.setVolume(this.volume);
        this.hls?.setVolume(this.volume);
        this.h265?.setVolume(this.volume);
    }
    setPlaybackRate(rate) {
        this.events.emit('log', `Jessibuca FLV live playbackRate is not exposed; requested ${rate}.`);
    }
    screenshot() {
        if (this.activeEngine === 'hls') {
            const canvas = this.options.container.querySelector('canvas');
            return canvas ? canvas.toDataURL('image/png') : '';
        }
        const result = this.jess?.screenshot('tesla-frame', 'png', 1, 'base64');
        return typeof result === 'string' ? result : '';
    }
    fullscreen() {
        const target = this.options.container;
        if (document.fullscreenElement)
            document.exitFullscreen().catch(() => undefined);
        else
            target.requestFullscreen?.().catch(() => undefined);
    }
    getStats() {
        if (this.activeEngine === 'hls' && this.hls) {
            return { ...this.hls.getStats(), sourceType: this.sourceType };
        }
        return this.stats.snapshot();
    }
    getState() {
        return this.state.current;
    }
    async ensureJessibuca() {
        if (this.jess)
            return;
        this.hls?.destroy();
        this.hls = undefined;
        this.activeEngine = 'jessibuca';
        await loadJessibuca(this.options.jessibucaUrl || new URL('./jessibuca.js', import.meta.url).href);
        const Jessibuca = window.Jessibuca;
        if (!Jessibuca)
            throw new Error('Jessibuca constructor is not available.');
        this.options.container.innerHTML = '';
        this.jess = new Jessibuca({
            container: this.options.container,
            decoder: this.options.decoderUrl || new URL('./decoder.js', import.meta.url).href,
            videoBuffer: this.options.videoBuffer ?? 0.2,
            isResize: this.options.fitMode !== 'fill',
            isFullResize: this.options.fitMode === 'cover',
            hasAudio: true,
            isNotMute: this.volume > 0,
            useMSE: false,
            useWCS: false,
            autoWasm: true,
            debug: !!this.options.debug,
            loadingText: this.options.loadingText || 'loading',
            showBandwidth: true,
            operateBtns: {
                fullscreen: true,
                screenshot: true,
                play: true,
                audio: true,
                record: false
            },
            heartTimeoutReplay: true,
            heartTimeoutReplayTimes: 3,
            loadingTimeoutReplay: true,
            loadingTimeoutReplayTimes: 3,
            wasmDecodeErrorReplay: true
        });
        this.bindJessibucaEvents(this.jess);
        this.jess.setVolume(this.volume);
    }
    async playWithHlsEngine() {
        this.jess?.destroy();
        this.jess = undefined;
        this.h265?.destroy();
        this.h265 = undefined;
        if (!this.hls) {
            this.options.container.innerHTML = '';
            this.hls = new HlsWebCodecsEngine({
                container: this.options.container,
                renderer: this.options.renderer === 'canvas' ? 'canvas2d' : 'webgl',
                workerUrl: this.options.workerUrl,
                fitMode: this.options.fitMode,
                liveStartSegmentCount: this.options.liveStartSegmentCount ?? 3,
                liveSegmentBatch: this.options.liveSegmentBatch ?? 2,
                audioMaxQueueMs: this.options.audioMaxQueueMs ?? 1200,
                decodeBatchSize: this.options.decodeBatchSize,
                maxRenderQueue: this.options.maxRenderQueue,
                lateDropMs: this.options.lateDropMs
            });
            this.bindHlsEvents(this.hls);
            this.hls.setVolume(this.volume);
        }
        this.activeEngine = 'hls';
        this.stats.patch({ sourceType: this.sourceType, decoderType: 'webcodecs', rendererType: this.options.renderer === 'canvas' ? 'canvas2d' : 'webgl', audioType: 'webaudio' });
        await this.hls.play(this.url, this.sourceType);
    }
    async playWithH265WebEngine() {
        this.jess?.destroy();
        this.jess = undefined;
        this.hls?.destroy();
        this.hls = undefined;
        if (!this.h265)
            this.h265 = new H265WebEngine(this.options.container, this.options);
        this.activeEngine = 'h265web';
        this.state.transition('loading');
        this.stats.patch({
            sourceType: 'h265',
            decoderType: 'wasm',
            rendererType: 'canvas2d',
            audioType: 'webaudio',
            lastError: ''
        });
        this.events.emit('state', this.state.current);
        try {
            await this.h265.play(this.url);
            this.state.transition('playing');
            this.events.emit('state', this.state.current);
        }
        catch (error) {
            this.fail(error instanceof Error ? error : new Error(String(error)));
        }
    }
    bindHlsEvents(engine) {
        engine.events.on('state', state => {
            this.state.transition(state);
            this.events.emit('state', this.state.current);
        });
        engine.events.on('error', error => this.fail(error));
        engine.events.on('log', message => this.events.emit('log', message));
        engine.events.on('firstFrame', ms => {
            this.stats.patch({ firstFrameTimeMs: ms });
            this.events.emit('firstFrame', ms);
        });
    }
    bindJessibucaEvents(jess) {
        const bind = (event, handler) => {
            jess.on(event, handler);
            this.handlers.push({ event, handler });
        };
        bind('load', () => this.events.emit('log', 'Jessibuca loaded.'));
        bind('start', () => this.markPlaying());
        bind('play', () => this.markPlaying());
        bind('error', (error) => this.fail(new Error(typeof error === 'string' ? error : JSON.stringify(error))));
        bind('timeout', (payload) => this.fail(new Error(`Jessibuca timeout: ${JSON.stringify(payload)}`)));
        bind('videoInfo', (info) => {
            this.events.emit('log', `Video ${info?.encType || ''} ${info?.width || 0}x${info?.height || 0}`);
        });
        bind('audioInfo', (info) => {
            this.events.emit('log', `Audio ${info?.encType || ''} ${info?.sampleRate || 0}Hz/${info?.channels || 0}ch`);
        });
        bind('stats', (payload) => {
            const stats = typeof payload === 'string' ? safeJson(payload) : payload || {};
            this.stats.patch({
                fps: Number(stats.fps) || 0,
                audioQueueMs: Number(stats.buf) || 0,
                currentTime: Number(stats.ts) ? Number(stats.ts) / 1000 : 0,
                currentTimeMs: Number(stats.ts) || 0,
                bitrate: Math.round(((Number(stats.abps) || 0) + (Number(stats.vbps) || 0)) / 1000)
            });
            this.events.emit('stats', this.getStats());
        });
        bind('kBps', (value) => {
            const kbps = Number(value);
            if (Number.isFinite(kbps))
                this.stats.patch({ bitrate: Math.round(kbps * 8) });
        });
    }
    markPlaying() {
        if (!this.firstFrameSeen) {
            this.firstFrameSeen = true;
            const firstFrameTimeMs = Math.round(performance.now() - this.firstFrameStart);
            this.stats.patch({ firstFrameTimeMs });
            this.events.emit('firstFrame', firstFrameTimeMs);
        }
        this.state.transition('playing');
        this.events.emit('state', this.state.current);
    }
    fail(error) {
        this.state.transition('error');
        this.stats.patch({ lastError: error.message });
        this.events.emit('state', this.state.current);
        this.events.emit('error', error);
    }
}
function safeJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return {};
    }
}
function createTeslaPlayer(container, options = {}) {
    return new TeslaPlayer(container, options);
}

/*
 * Tesla-VideoPlayer public entry.
 * Based on Jessibuca open source architecture and distributed under GPL-3.0.
 */
if (typeof window !== 'undefined') {
    window.TeslaPlayer = TeslaPlayer;
    window.TeslaStandalonePlayer = TeslaPlayer;
    window.createTeslaPlayer = createTeslaPlayer;
}

export { TeslaPlayer, TeslaPlayer as TeslaStandalonePlayer, createTeslaPlayer };
//# sourceMappingURL=index.js.map
