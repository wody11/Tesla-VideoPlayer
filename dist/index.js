export { d as decodePesTimestamp, a as demuxTS } from './demux-ts-6eb45a7f.js';

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
function createInitialStats() {
    return {
        sourceType: 'unknown',
        decoderType: 'none',
        rendererType: 'none',
        audioType: 'none',
        videoTagCount: 0,
        audioSampleCount: 0,
        videoElementCount: 0,
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
        discontinuityCount: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        lastError: ''
    };
}
class PlayerStatsTracker {
    constructor(scope) {
        this.scope = scope;
        this.stats = createInitialStats();
        this.frameTicks = 0;
        this.lastFpsAt = now();
    }
    setScope(scope) {
        this.scope = scope;
    }
    resetSession(values = {}) {
        this.stats = { ...createInitialStats(), ...values };
        this.frameTicks = 0;
        this.lastFpsAt = now();
    }
    patch(values) {
        this.stats = { ...this.stats, ...values };
    }
    incrementReconnect() {
        this.stats.reconnectCount += 1;
    }
    markDiscontinuity() {
        this.stats.discontinuityCount += 1;
    }
    markDecoded() {
        this.stats.decodedFrames += 1;
    }
    markDropped() {
        this.stats.droppedFrames += 1;
    }
    markRendered() {
        this.frameTicks += 1;
        const current = now();
        const elapsed = current - this.lastFpsAt;
        if (elapsed >= 1000) {
            this.stats.fps = Math.round((this.frameTicks * 1000) / elapsed);
            this.frameTicks = 0;
            this.lastFpsAt = current;
        }
    }
    snapshot() {
        if (this.scope) {
            this.stats.videoElementCount = this.scope.querySelectorAll('video').length;
            this.stats.canvasCount = this.scope.querySelectorAll('canvas').length;
        }
        return { ...this.stats };
    }
}
function now() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/*
 * Tesla-VideoPlayer is based on Jessibuca open source architecture.
 * Jessibuca is licensed under GPL-3.0. See THIRD_PARTY_NOTICES.md.
 */
const DEFAULT_PLAYER_OPTIONS = {
    decoderMode: 'auto',
    renderer: 'webgl',
    fitMode: 'contain',
    controls: false,
    autoplay: false,
    preset: 'balanced',
    volume: 1,
    reconnect: true,
    reconnectMaxRetries: 3,
    reconnectDelayMs: 1000
};
function normalizePlayerOptions(options) {
    return {
        ...DEFAULT_PLAYER_OPTIONS,
        ...options,
        volume: clamp(Number(options.volume ?? DEFAULT_PLAYER_OPTIONS.volume), 0, 1),
        reconnectMaxRetries: Math.max(0, Math.floor(Number(options.reconnectMaxRetries ?? DEFAULT_PLAYER_OPTIONS.reconnectMaxRetries))),
        reconnectDelayMs: Math.max(100, Math.floor(Number(options.reconnectDelayMs ?? DEFAULT_PLAYER_OPTIONS.reconnectDelayMs)))
    };
}
function clamp(value, min, max) {
    return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
}
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
function assertNoVideoElements(root = document) {
    return root.querySelectorAll('video').length;
}
class NoVideoGuard {
    start(onViolation, root = document) {
        this.stop();
        const check = () => {
            const count = assertNoVideoElements(root);
            if (count > 0)
                onViolation(count);
        };
        check();
        this.observer = new MutationObserver(check);
        this.observer.observe(root, { childList: true, subtree: true });
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
    reset() {
        this.stopScheduledSources();
        this.clock.reset();
        this.scheduledUntil = this.context.currentTime;
        this.enqueuedFrames = 0;
        this.lastFrameSamples = 0;
        this.lastTimestampUs = 0;
    }
    close() {
        this.reset();
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
    const reason = supported ? undefined : 'This playback route requires WebAudio and WebCodecs. Select the Jessibuca engine for supported FLV/WASM playback.';
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

/**
 * Tracks one active asynchronous playback session.
 *
 * Starting or invalidating a session makes every previously issued token stale,
 * so late Worker/WebCodecs callbacks can be ignored safely.
 */
class SessionGeneration {
    constructor() {
        this.generation = 0;
        this.active = false;
    }
    begin() {
        this.generation += 1;
        this.active = true;
        return this.generation;
    }
    invalidate() {
        this.generation += 1;
        this.active = false;
    }
    isCurrent(sessionId) {
        return this.active && sessionId === this.generation;
    }
    get current() {
        return this.generation;
    }
}

const DEFAULT_VIDEO_DECODE_QUEUE_LIMIT = 24;
function canDecodeVideo(configured, pendingSamples, renderQueueSize, decoderQueueSize, maxRenderQueue, decoderQueueLimit = DEFAULT_VIDEO_DECODE_QUEUE_LIMIT) {
    return configured
        && pendingSamples > 0
        && renderQueueSize < maxRenderQueue
        && decoderQueueSize < decoderQueueLimit;
}
/**
 * Bounds a live-video sample queue without resuming from an undecodable delta frame.
 * The newest key frame is retained with all samples after it. If there is no key
 * frame in the retained window, the queue is cleared and playback waits for one.
 */
function trimLiveVideoQueue(queue, maxSize) {
    const limit = Math.max(1, Math.floor(maxSize));
    if (queue.length <= limit)
        return 0;
    const searchStart = Math.max(0, queue.length - limit);
    let keepFrom = -1;
    for (let i = queue.length - 1; i >= searchStart; i -= 1) {
        if (queue[i].key) {
            keepFrom = i;
            break;
        }
    }
    if (keepFrom < 0) {
        const dropped = queue.length;
        queue.length = 0;
        return dropped;
    }
    const dropped = keepFrom;
    queue.splice(0, keepFrom);
    return dropped;
}

class HlsWebCodecsEngine {
    constructor(options) {
        this.options = options;
        this.events = new PlayerEvents();
        this.state = new PlayerStateMachine();
        this.sessions = new SessionGeneration();
        this.firstFrameStart = 0;
        this.firstFrameSeen = false;
        this.videoQueueLength = 0;
        this.stopped = true;
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
        this.stats = new PlayerStatsTracker(options.container);
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
    }
    async play(url, sourceType = 'hls', startTime = 0) {
        if (!url)
            throw new Error('Playback URL is required.');
        // Make every callback from the previous playback stale before releasing it.
        const sessionId = this.sessions.begin();
        this.releasePlaybackResources();
        this.stopped = false;
        this.paused = false;
        this.sourceType = sourceType;
        this.currentUrl = url;
        this.mp4PullOutstanding = 0;
        this.stats.resetSession({
            sourceType,
            decoderType: 'webcodecs',
            rendererType: this.renderer.type,
            audioType: 'webaudio'
        });
        this.firstFrameStart = performance.now();
        this.firstFrameSeen = false;
        this.state.transition('loading');
        this.events.emit('state', this.state.current);
        const capability = detectCapability(this.canvas);
        if (!capability.supported) {
            this.stats.patch({ decoderType: 'unsupported' });
            const error = new Error(capability.reason || 'Required browser capability is not available.');
            this.fail(error, sessionId);
            throw error;
        }
        try {
            const audio = new WebAudioPlayer();
            this.audio = audio;
            audio.setMaxQueueMs(this.settings.audioMaxQueueMs);
            audio.resume().catch(error => {
                if (this.sessions.isCurrent(sessionId)) {
                    this.events.emit('log', `AudioContext resume is pending or blocked: ${error?.message || error}`);
                }
            });
            const decoder = this.createDecoder(sessionId);
            this.decoder = decoder;
            this.stats.patch({ decoderType: 'webcodecs' });
            const worker = new Worker(this.options.workerUrl || new URL('./worker-entry.js', import.meta.url), { type: 'module' });
            this.worker = worker;
            worker.onmessage = event => this.handleWorkerEvent(event.data, sessionId);
            worker.onerror = event => this.fail(new Error(event.message || 'Playback worker failed.'), sessionId);
            if (sourceType === 'mp4')
                worker.postMessage({ type: 'open-mp4', url, startTime });
            else if (sourceType === 'hls')
                worker.postMessage({
                    type: 'open-hls', url,
                    liveStartSegmentCount: this.settings.liveStartSegmentCount,
                    liveSegmentBatch: this.settings.liveSegmentBatch,
                    startTime
                });
            else
                worker.postMessage({ type: sourceType === 'ws-flv' ? 'open-ws-flv' : 'open-http-flv', url });
        }
        catch (error) {
            const normalized = error instanceof Error ? error : new Error(String(error));
            this.fail(normalized, sessionId);
            throw normalized;
        }
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
        const sessionId = this.sessions.current;
        const pausedDuration = performance.now() - this.pausedAtMs;
        if (this.videoWallClockBaseMs !== undefined)
            this.videoWallClockBaseMs += pausedDuration;
        await this.audio?.resume();
        if (!this.sessions.isCurrent(sessionId))
            return;
        this.paused = false;
        this.worker?.postMessage({ type: 'resume' });
        this.state.transition('playing');
        this.events.emit('state', this.state.current);
        if (this.pendingVideoSamples.length || this.pendingAudioSamples.length)
            this.ensureDecodePump(sessionId);
        if (this.renderQueue.length)
            this.ensureRenderLoop(sessionId);
    }
    async seek(time) {
        if (this.sourceType !== 'mp4' && this.sourceType !== 'hls')
            throw new Error('seek() is available for MP4 and HLS on-demand playback only.');
        this.state.transition('seeking');
        this.events.emit('state', this.state.current);
        await this.play(this.currentUrl, this.sourceType, Math.max(0, Number(time) || 0));
    }
    stop() {
        this.sessions.invalidate();
        this.releasePlaybackResources();
        this.state.transition('stopped');
        this.events.emit('state', this.state.current);
    }
    destroy() {
        this.sessions.invalidate();
        this.releasePlaybackResources();
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
            currentTimeMs: this.audio?.currentTimeMs() || 0,
            currentTime: (this.audio?.currentTimeMs() || 0) / 1000
        });
        return this.stats.snapshot();
    }
    setRenderer(type) {
        if (this.renderer.type === type)
            return;
        this.renderer.destroy();
        this.renderer = this.createRenderer(type);
        this.stats.patch({ rendererType: this.renderer.type });
    }
    updateSettings(values) {
        this.options = { ...this.options, ...values };
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
    createDecoder(sessionId) {
        return new WebCodecsDecoder({
            onVideoFrame: frame => this.handleVideoFrame(frame, sessionId),
            onAudioFrame: frame => this.handleAudioFrame(frame, sessionId),
            onError: error => this.fail(error, sessionId)
        });
    }
    resetForDiscontinuity(sessionId, sequence) {
        if (!this.sessions.isCurrent(sessionId))
            return;
        this.decoder?.close();
        this.decoder = this.createDecoder(sessionId);
        this.audio?.reset();
        this.videoConfigured = false;
        this.audioConfigured = false;
        this.seenKeyFrame = false;
        this.pendingVideoSamples = [];
        this.pendingAudioSamples = [];
        this.videoQueueLength = 0;
        this.videoWallClockBaseUs = undefined;
        this.videoWallClockBaseMs = undefined;
        this.clearDecodePump();
        this.clearRenderQueue();
        this.stats.markDiscontinuity();
        this.events.emit('log', `HLS discontinuity at media sequence ${sequence}; decoder and AV clocks reset.`);
    }
    handleWorkerEvent(message, sessionId) {
        if (!this.sessions.isCurrent(sessionId) || this.stopped)
            return;
        try {
            if (message.type === 'stream-open') {
                this.events.emit('log', 'Stream opened.');
            }
            else if (message.type === 'stream-end') {
                this.events.emit('log', 'Stream ended.');
            }
            else if (message.type === 'discontinuity') {
                this.resetForDiscontinuity(sessionId, message.sequence);
            }
            else if (message.type === 'download-progress') {
                this.stats.patch({ downloadedBytes: message.loaded, totalBytes: message.total || 0 });
            }
            else if (message.type === 'media-info') {
                this.stats.patch({ duration: message.duration });
                this.events.emit('log', `Media info: ${message.videoCodec || 'no video'} / ${message.audioCodec || 'no audio'}, ${message.duration.toFixed(2)}s.`);
                this.ensureMp4Pull();
            }
            else if (message.type === 'video-config') {
                this.events.emit('log', `Video config received: ${message.codec}${message.annexb ? ' annexb' : ''}`);
                const decoder = this.decoder;
                decoder?.configureVideo(message).then(() => {
                    if (!this.sessions.isCurrent(sessionId) || decoder !== this.decoder)
                        return;
                    this.videoConfigured = true;
                    this.events.emit('log', `VideoDecoder configured, queued video samples: ${this.pendingVideoSamples.length}.`);
                    this.ensureDecodePump(sessionId);
                }).catch(error => this.fail(error, sessionId));
            }
            else if (message.type === 'audio-config') {
                this.events.emit('log', `Audio config received: ${message.codec} ${message.sampleRate}Hz/${message.numberOfChannels}ch`);
                const decoder = this.decoder;
                decoder?.configureAudio(message).then(() => {
                    if (!this.sessions.isCurrent(sessionId) || decoder !== this.decoder)
                        return;
                    this.audioConfigured = true;
                    this.ensureDecodePump(sessionId);
                }).catch(error => this.fail(error, sessionId));
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
                if (this.sourceType !== 'mp4') {
                    const maxPending = Math.max(120, this.settings.maxRenderQueue * 4);
                    const dropped = trimLiveVideoQueue(this.pendingVideoSamples, maxPending);
                    if (dropped > 0) {
                        this.videoQueueLength = Math.max(0, this.videoQueueLength - dropped);
                        for (let i = 0; i < dropped; i += 1)
                            this.stats.markDropped();
                        this.seenKeyFrame = this.pendingVideoSamples.length > 0;
                    }
                }
                if (this.videoConfigured)
                    this.ensureDecodePump(sessionId);
            }
            else if (message.type === 'audio-sample') {
                if (this.sourceType === 'mp4')
                    this.mp4PullOutstanding = Math.max(0, this.mp4PullOutstanding - 1);
                this.pendingAudioSamples.push(message);
                if (this.audioConfigured)
                    this.ensureDecodePump(sessionId);
            }
            else if (message.type === 'stats') {
                this.stats.patch({ videoTagCount: message.videoTagCount, audioSampleCount: message.audioTagCount });
            }
            else if (message.type === 'log') {
                this.events.emit('log', message.message);
            }
            else if (message.type === 'error') {
                this.fail(new Error(message.message), sessionId);
            }
        }
        catch (error) {
            this.fail(error instanceof Error ? error : new Error(String(error)), sessionId);
        }
    }
    handleVideoFrame(frame, sessionId) {
        if (!this.sessions.isCurrent(sessionId)) {
            try {
                frame.close();
            }
            catch { }
            return;
        }
        const timestamp = typeof frame.timestamp === 'number' ? frame.timestamp : 0;
        if (this.videoWallClockBaseUs === undefined) {
            this.videoWallClockBaseUs = timestamp;
            this.videoWallClockBaseMs = performance.now();
        }
        this.stats.markDecoded();
        this.renderQueue.push({ frame, timestamp });
        this.renderQueue.sort((a, b) => a.timestamp - b.timestamp);
        while (this.renderQueue.length > this.settings.maxRenderQueue) {
            const old = this.renderQueue.shift();
            try {
                old?.frame.close();
            }
            catch { }
            this.videoQueueLength = Math.max(0, this.videoQueueLength - 1);
            this.stats.markDropped();
        }
        this.ensureRenderLoop(sessionId);
        if (this.pendingVideoSamples.length > 0)
            this.ensureDecodePump(sessionId);
    }
    handleAudioFrame(frame, sessionId) {
        if (!this.sessions.isCurrent(sessionId)) {
            try {
                frame.close();
            }
            catch { }
            return;
        }
        try {
            this.audio?.enqueue(frame);
        }
        finally {
            frame.close();
        }
    }
    fail(error, sessionId = this.sessions.current) {
        if (!this.sessions.isCurrent(sessionId))
            return;
        this.sessions.invalidate();
        this.releasePlaybackResources();
        this.stats.patch({ lastError: error.message });
        this.state.transition('error');
        this.events.emit('state', this.state.current);
        this.events.emit('error', error);
    }
    ensureRenderLoop(sessionId = this.sessions.current) {
        if (!this.sessions.isCurrent(sessionId) || this.renderLoopId !== undefined)
            return;
        this.renderLoopId = window.setTimeout(() => this.renderTick(sessionId), 8);
    }
    ensureDecodePump(sessionId = this.sessions.current, delayMs = 0) {
        if (!this.sessions.isCurrent(sessionId) || this.decodePumpId !== undefined)
            return;
        this.decodePumpId = window.setTimeout(() => this.decodeTick(sessionId), delayMs);
    }
    decodeTick(sessionId) {
        this.decodePumpId = undefined;
        if (!this.sessions.isCurrent(sessionId) || this.stopped || this.paused)
            return;
        let videoBudget = this.settings.decodeBatchSize;
        while (videoBudget > 0 && canDecodeVideo(this.videoConfigured, this.pendingVideoSamples.length, this.renderQueue.length, this.decoder?.videoDecodeQueueSize() || 0, this.settings.maxRenderQueue)) {
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
        const videoCanContinue = canDecodeVideo(this.videoConfigured, this.pendingVideoSamples.length, this.renderQueue.length, this.decoder?.videoDecodeQueueSize() || 0, this.settings.maxRenderQueue);
        const audioCanContinue = this.audioConfigured && this.pendingAudioSamples.length > 0
            && (this.audio?.queuedMs() || 0) < this.settings.audioMaxQueueMs * 1.25
            && (this.decoder?.audioDecodeQueueSize() || 0) < 32;
        if (videoCanContinue || audioCanContinue) {
            this.ensureDecodePump(sessionId);
        }
        else if (this.pendingVideoSamples.length > 0 || this.pendingAudioSamples.length > 0) {
            this.ensureDecodePump(sessionId, 12);
        }
    }
    renderTick(sessionId) {
        this.renderLoopId = undefined;
        if (!this.sessions.isCurrent(sessionId))
            return;
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
            this.ensureRenderLoop(sessionId);
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
    releasePlaybackResources() {
        this.stopped = true;
        this.paused = false;
        const worker = this.worker;
        this.worker = undefined;
        if (worker) {
            worker.onmessage = null;
            worker.onerror = null;
            try {
                worker.postMessage({ type: 'stop' });
            }
            catch { }
            worker.terminate();
        }
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

function resolveEngineRoute(sourceType, decoderMode = 'auto', enableH265Web = false) {
    if (sourceType === 'h265')
        return enableH265Web ? 'h265web' : 'unsupported';
    if (sourceType === 'hls' || sourceType === 'mp4') {
        return decoderMode === 'wasm' ? 'unsupported' : 'webcodecs';
    }
    if (sourceType === 'http-flv' || sourceType === 'ws-flv') {
        return decoderMode === 'webcodecs' ? 'webcodecs' : 'jessibuca';
    }
    return 'unsupported';
}

function createFullscreenControl(player) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Fullscreen';
    button.onclick = () => player.fullscreen();
    return button;
}

function createPlayButton(player) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Play';
    button.onclick = () => player.play().catch(error => player.events.emit('error', error));
    return button;
}

function createScreenshotControl(player) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Shot';
    button.onclick = () => {
        const url = player.screenshot();
        const link = document.createElement('a');
        link.href = url;
        link.download = `tesla-frame-${Date.now()}.png`;
        link.click();
    };
    return button;
}

function createVolumeControl(player) {
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '1';
    input.step = '0.01';
    input.value = '1';
    input.oninput = () => player.setVolume(Number(input.value));
    return input;
}

/*
 * Lightweight Jessibuca-style control bar for Tesla no-video player.
 */
class ControlBar {
    constructor(player) {
        this.player = player;
        this.element = document.createElement('div');
        this.element.className = 'tesla-control-bar';
        this.element.style.cssText = 'position:absolute;left:0;right:0;bottom:0;z-index:20;display:flex;gap:8px;align-items:center;padding:8px;background:rgba(17,17,17,.85);color:#fff;';
        const pause = document.createElement('button');
        pause.type = 'button';
        pause.textContent = 'Pause';
        pause.onclick = () => this.player.pause();
        const stop = document.createElement('button');
        stop.type = 'button';
        stop.textContent = 'Stop';
        stop.onclick = () => this.player.stop();
        this.element.append(createPlayButton(player), pause, stop, createVolumeControl(player), createFullscreenControl(player), createScreenshotControl(player));
    }
    destroy() {
        this.element.remove();
    }
}

/*
 * Tesla-VideoPlayer runtime uses Tesla's WebCodecs worker pipeline and the
 * vendored Jessibuca WASM runtime without HTML video or MSE fallback.
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
        this.events = new PlayerEvents();
        this.state = new PlayerStateMachine();
        this.guard = new NoVideoGuard();
        this.activeEngine = 'none';
        this.url = '';
        this.sourceType = 'unknown';
        this.firstFrameStart = 0;
        this.firstFrameSeen = false;
        this.volume = 1;
        this.handlers = [];
        this.reconnectAttempts = 0;
        this.on = this.events.on.bind(this.events);
        this.off = this.events.off.bind(this.events);
        const supplied = containerOrOptions instanceof HTMLElement
            ? { ...maybeOptions, container: containerOrOptions }
            : containerOrOptions;
        this.options = normalizePlayerOptions(supplied);
        if (!this.options.container)
            throw new Error('createTeslaPlayer requires a container element.');
        (_a = this.options.container.style).position || (_a.position = 'relative');
        (_b = this.options.container.style).background || (_b.background = '#000');
        this.stats = new PlayerStatsTracker(this.options.container);
        this.volume = this.options.volume ?? 1;
        this.guard.start(count => this.fail(new Error(`video elements are forbidden, found ${count}.`)), this.options.container);
        this.syncControls();
        if (this.options.url) {
            this.load(this.options.url, this.options);
            if (this.options.autoplay) {
                queueMicrotask(() => this.play().catch(error => this.handlePlaybackError(normalizeError(error))));
            }
        }
    }
    load(url, options = {}) {
        if (this.state.current === 'destroyed')
            throw new Error('Cannot load media after destroy().');
        this.url = url;
        this.options = normalizePlayerOptions({ ...this.options, ...options, container: this.options.container });
        this.sourceType = options.sourceType || inferSourceType(url);
        this.volume = this.options.volume ?? this.volume;
        this.stats.resetSession({ sourceType: this.sourceType, lastError: '' });
        this.applyWebCodecsOptions();
        this.jess?.setVolume(this.volume);
        this.hls?.setVolume(this.volume);
        this.h265?.setVolume(this.volume);
        this.syncControls();
    }
    async play(url, options = {}) {
        if (url)
            this.load(url, options);
        if (!this.url)
            throw new Error('Playback URL is required.');
        if (this.state.current === 'destroyed')
            throw new Error('Cannot play media after destroy().');
        this.clearReconnectTimer();
        this.reconnectAttempts = 0;
        await this.playCurrent(false);
    }
    pause() {
        if (this.activeEngine === 'webcodecs')
            this.hls?.pause();
        else if (this.activeEngine === 'h265web')
            this.h265?.pause();
        else if (this.activeEngine === 'jessibuca')
            this.jess?.pause().catch(error => this.handlePlaybackError(normalizeError(error)));
        else
            return;
        this.state.transition('paused');
        this.events.emit('state', this.state.current);
    }
    async resume() {
        if (this.activeEngine === 'webcodecs')
            await this.hls?.resume();
        else if (this.activeEngine === 'h265web')
            await this.h265?.play(this.url);
        else if (this.activeEngine === 'jessibuca')
            await this.jess?.play();
    }
    stop() {
        this.clearReconnectTimer();
        this.reconnectAttempts = 0;
        this.stopActiveEngine();
        this.activeEngine = 'none';
        this.state.transition('stopped');
        this.events.emit('state', this.state.current);
    }
    destroy() {
        if (this.state.current === 'destroyed')
            return;
        this.clearReconnectTimer();
        this.destroyJessibuca();
        this.hls?.destroy();
        this.h265?.destroy();
        this.hls = undefined;
        this.h265 = undefined;
        this.controlBar?.destroy();
        this.controlBar = undefined;
        this.activeEngine = 'none';
        this.guard.stop();
        this.state.transition('destroyed');
        this.events.clear();
    }
    seek(time) {
        if (this.activeEngine === 'webcodecs' && (this.sourceType === 'mp4' || this.sourceType === 'hls')) {
            this.hls?.seek(time).catch(error => this.handlePlaybackError(normalizeError(error)));
            return;
        }
        this.fail(new Error(`seek() is only supported for MP4/HLS on-demand playback; current source is ${this.sourceType}.`));
    }
    setVolume(volume) {
        this.volume = Math.max(0, Math.min(1, Number(volume) || 0));
        this.options.volume = this.volume;
        this.jess?.setVolume(this.volume);
        this.hls?.setVolume(this.volume);
        this.h265?.setVolume(this.volume);
    }
    setPlaybackRate(rate) {
        this.events.emit('log', `Playback-rate control is not supported by the selected ${this.activeEngine} engine; requested ${rate}.`);
    }
    screenshot() {
        if (this.activeEngine === 'webcodecs') {
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
        const outer = this.stats.snapshot();
        if (this.activeEngine === 'webcodecs' && this.hls) {
            const engine = this.hls.getStats();
            return {
                ...engine,
                sourceType: this.sourceType,
                reconnectCount: outer.reconnectCount,
                lastError: outer.lastError || engine.lastError
            };
        }
        return outer;
    }
    getState() {
        return this.state.current;
    }
    async playCurrent(isReconnect) {
        const route = resolveEngineRoute(this.sourceType, this.options.decoderMode, !!this.options.enableH265Web);
        if (!isReconnect) {
            this.stats.resetSession({
                sourceType: this.sourceType,
                decoderType: route === 'webcodecs' ? 'webcodecs' : route === 'jessibuca' || route === 'h265web' ? 'wasm' : 'none',
                rendererType: route === 'webcodecs'
                    ? (this.options.renderer === 'canvas' ? 'canvas2d' : 'webgl')
                    : route === 'jessibuca' || route === 'h265web' ? 'canvas2d' : 'none',
                audioType: 'webaudio'
            });
        }
        if (route === 'webcodecs') {
            await this.playWithWebCodecsEngine();
            return;
        }
        if (route === 'jessibuca') {
            await this.playWithJessibuca();
            return;
        }
        if (route === 'h265web') {
            await this.playWithH265WebEngine();
            return;
        }
        if ((this.sourceType === 'hls' || this.sourceType === 'mp4') && this.options.decoderMode === 'wasm') {
            throw new Error('decoderMode="wasm" is not available for MP4/HLS because the typed WASM bridge is not implemented. Use decoderMode="auto" or "webcodecs".');
        }
        if (this.sourceType === 'h265') {
            throw new Error('H.265 experimental playback requires enableH265Web and supplied h265web.js runtime/wasm assets.');
        }
        throw new Error(`Unsupported or unrecognized media source: ${this.url}`);
    }
    async playWithJessibuca() {
        this.hls?.destroy();
        this.hls = undefined;
        this.h265?.destroy();
        this.h265 = undefined;
        this.destroyJessibuca();
        await loadJessibuca(this.options.jessibucaUrl || new URL('./jessibuca.js', import.meta.url).href);
        const Jessibuca = window.Jessibuca;
        if (!Jessibuca)
            throw new Error('Jessibuca constructor is not available.');
        this.options.container.innerHTML = '';
        this.options.reconnect !== false;
        const retries = this.options.reconnectMaxRetries ?? 3;
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
            operateBtns: this.options.controls ? {
                fullscreen: true,
                screenshot: true,
                play: true,
                audio: true,
                record: false
            } : {
                fullscreen: false,
                screenshot: false,
                play: false,
                audio: false,
                record: false
            },
            // TeslaPlayer owns the retry timer so all engines follow the same policy.
            heartTimeoutReplay: false,
            heartTimeoutReplayTimes: retries,
            loadingTimeoutReplay: false,
            loadingTimeoutReplayTimes: retries,
            wasmDecodeErrorReplay: false
        });
        this.bindJessibucaEvents(this.jess);
        this.jess.setVolume(this.volume);
        this.activeEngine = 'jessibuca';
        this.firstFrameStart = performance.now();
        this.firstFrameSeen = false;
        this.state.transition('loading');
        this.events.emit('state', this.state.current);
        this.syncControls();
        await this.jess.play(this.url);
    }
    async playWithWebCodecsEngine() {
        this.destroyJessibuca();
        this.h265?.destroy();
        this.h265 = undefined;
        if (!this.hls) {
            this.options.container.innerHTML = '';
            this.hls = new HlsWebCodecsEngine(this.webCodecsOptions());
            this.bindHlsEvents(this.hls);
        }
        else {
            this.applyWebCodecsOptions();
        }
        this.hls.setVolume(this.volume);
        this.activeEngine = 'webcodecs';
        this.syncControls();
        await this.hls.play(this.url, this.sourceType);
    }
    async playWithH265WebEngine() {
        this.destroyJessibuca();
        this.hls?.destroy();
        this.hls = undefined;
        if (!this.h265)
            this.h265 = new H265WebEngine(this.options.container, this.options);
        this.activeEngine = 'h265web';
        this.state.transition('loading');
        this.events.emit('state', this.state.current);
        this.syncControls();
        try {
            await this.h265.play(this.url);
            this.markPlaying();
        }
        catch (error) {
            this.handlePlaybackError(normalizeError(error));
        }
    }
    webCodecsOptions() {
        return {
            container: this.options.container,
            renderer: this.options.renderer === 'canvas' ? 'canvas2d' : 'webgl',
            workerUrl: this.options.workerUrl,
            fitMode: this.options.fitMode,
            preset: this.options.preset,
            liveStartSegmentCount: this.options.liveStartSegmentCount ?? 3,
            liveSegmentBatch: this.options.liveSegmentBatch ?? 2,
            audioMaxQueueMs: this.options.audioMaxQueueMs ?? 1200,
            decodeBatchSize: this.options.decodeBatchSize,
            maxRenderQueue: this.options.maxRenderQueue,
            lateDropMs: this.options.lateDropMs
        };
    }
    applyWebCodecsOptions() {
        if (!this.hls)
            return;
        const values = this.webCodecsOptions();
        this.hls.updateSettings(values);
        this.hls.setRenderer(values.renderer || 'webgl');
    }
    syncControls() {
        if (!this.options.controls) {
            this.controlBar?.destroy();
            this.controlBar = undefined;
            return;
        }
        if (!this.controlBar || !this.controlBar.element.isConnected) {
            this.controlBar?.destroy();
            this.controlBar = new ControlBar(this);
            this.options.container.appendChild(this.controlBar.element);
        }
    }
    bindHlsEvents(engine) {
        engine.events.on('state', state => {
            this.state.transition(state);
            this.events.emit('state', this.state.current);
        });
        engine.events.on('error', error => this.handlePlaybackError(error));
        engine.events.on('log', message => this.events.emit('log', message));
        engine.events.on('firstFrame', ms => {
            this.reconnectAttempts = 0;
            this.stats.patch({ firstFrameTimeMs: ms, lastError: '' });
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
        bind('error', (error) => this.handlePlaybackError(new Error(typeof error === 'string' ? error : JSON.stringify(error))));
        bind('timeout', (payload) => this.handlePlaybackError(new Error(`Jessibuca timeout: ${JSON.stringify(payload)}`)));
        bind('videoInfo', (info) => this.events.emit('log', `Video ${info?.encType || ''} ${info?.width || 0}x${info?.height || 0}`));
        bind('audioInfo', (info) => this.events.emit('log', `Audio ${info?.encType || ''} ${info?.sampleRate || 0}Hz/${info?.channels || 0}ch`));
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
        this.clearReconnectTimer();
        this.reconnectAttempts = 0;
        this.stats.patch({ lastError: '' });
        if (!this.firstFrameSeen) {
            this.firstFrameSeen = true;
            const firstFrameTimeMs = Math.round(performance.now() - this.firstFrameStart);
            this.stats.patch({ firstFrameTimeMs });
            this.events.emit('firstFrame', firstFrameTimeMs);
        }
        this.state.transition('playing');
        this.events.emit('state', this.state.current);
    }
    handlePlaybackError(error) {
        if (this.state.current === 'destroyed' || this.reconnectTimer !== undefined)
            return;
        const canReconnect = this.options.reconnect !== false
            && (this.sourceType === 'http-flv' || this.sourceType === 'ws-flv' || this.sourceType === 'hls')
            && this.reconnectAttempts < (this.options.reconnectMaxRetries ?? 3);
        if (!canReconnect) {
            this.fail(error);
            return;
        }
        this.stopActiveEngine();
        this.activeEngine = 'none';
        this.reconnectAttempts += 1;
        this.stats.incrementReconnect();
        this.stats.patch({ lastError: error.message });
        this.events.emit('reconnect', this.reconnectAttempts);
        this.state.transition('loading');
        this.events.emit('state', this.state.current);
        const delay = (this.options.reconnectDelayMs ?? 1000) * this.reconnectAttempts;
        this.clearReconnectTimer();
        this.reconnectTimer = window.setTimeout(() => {
            this.reconnectTimer = undefined;
            this.playCurrent(true).catch(next => this.handlePlaybackError(normalizeError(next)));
        }, delay);
    }
    stopActiveEngine() {
        if (this.activeEngine === 'webcodecs')
            this.hls?.stop();
        else if (this.activeEngine === 'h265web')
            this.h265?.stop();
        else if (this.activeEngine === 'jessibuca')
            this.jess?.close();
    }
    destroyJessibuca() {
        if (!this.jess)
            return;
        for (const { event, handler } of this.handlers)
            this.jess.off?.(event, handler);
        this.handlers = [];
        try {
            this.jess.destroy();
        }
        catch { }
        this.jess = undefined;
    }
    clearReconnectTimer() {
        if (this.reconnectTimer !== undefined) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
    }
    fail(error) {
        if (this.state.current === 'destroyed')
            return;
        this.clearReconnectTimer();
        this.stopActiveEngine();
        this.activeEngine = 'none';
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
function normalizeError(error) {
    return error instanceof Error ? error : new Error(String(error));
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
