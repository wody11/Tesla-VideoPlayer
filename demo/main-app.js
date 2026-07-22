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
        audioTimelineResets: 0,
        audioUnderruns: 0,
        audioStartupBufferMs: 0,
        audioDroppedSamples: 0,
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
    markAudioDropped(count = 1) {
        this.stats.audioDroppedSamples += Math.max(0, Math.floor(count));
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
    reconnectDelayMs: 1000,
    responsive: true,
    aspectRatio: 'video',
    maxViewportHeightRatio: 1
};
function normalizePlayerOptions(options) {
    return {
        ...DEFAULT_PLAYER_OPTIONS,
        ...options,
        volume: clamp(Number(options.volume ?? DEFAULT_PLAYER_OPTIONS.volume), 0, 1),
        reconnectMaxRetries: Math.max(0, Math.floor(Number(options.reconnectMaxRetries ?? DEFAULT_PLAYER_OPTIONS.reconnectMaxRetries))),
        reconnectDelayMs: Math.max(100, Math.floor(Number(options.reconnectDelayMs ?? DEFAULT_PLAYER_OPTIONS.reconnectDelayMs))),
        responsive: options.responsive !== false,
        aspectRatio: normalizeAspectRatio(options.aspectRatio ?? DEFAULT_PLAYER_OPTIONS.aspectRatio),
        maxViewportHeightRatio: clamp(Number(options.maxViewportHeightRatio ?? DEFAULT_PLAYER_OPTIONS.maxViewportHeightRatio), 0.25, 1)
    };
}
function normalizeAspectRatio(value) {
    if (value === 'video')
        return value;
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : 16 / 9;
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

function deriveAudioStartupBufferMs(maxQueueMs) {
    const normalized = Math.max(300, Math.min(5000, Number(maxQueueMs) || 1500));
    return Math.round(Math.max(80, Math.min(260, normalized * 0.12)));
}
function decideAudioTimelineReset(input) {
    const maxQueueMs = Math.max(300, Number(input.maxQueueMs) || 1500);
    if (input.queuedMs > Math.max(maxQueueMs * 1.6, maxQueueMs + 800))
        return 'backlog';
    if (input.hasStarted && Math.abs(input.mediaGapMs) > 160)
        return 'timestamp-gap';
    if (input.hasStarted && input.queuedMs < -25)
        return 'underrun';
    return 'none';
}
function calculateAudioStartTime(nowSeconds, scheduledUntilSeconds, startupBufferMs, startsNewTimeline) {
    const now = Math.max(0, Number(nowSeconds) || 0);
    const scheduledUntil = Math.max(0, Number(scheduledUntilSeconds) || 0);
    const leadSeconds = Math.max(0.015, (Math.max(0, Number(startupBufferMs) || 0)) / 1000);
    const timelineTarget = startsNewTimeline
        ? Math.max(scheduledUntil, now + leadSeconds)
        : scheduledUntil;
    return Math.max(now + 0.015, timelineTarget);
}

// Schedules decoded AudioData through WebAudio without using media elements.
class WebAudioPlayer {
    constructor(options = {}) {
        this.clock = new AudioClock();
        this.scheduledUntil = 0;
        this.sources = new Set();
        this.maxQueueMs = 1500;
        this.startupBufferMs = 180;
        this.enqueuedFrames = 0;
        this.lastFrameSamples = 0;
        this.lastTimestampUs = 0;
        this.timelineResetCount = 0;
        this.underrunCount = 0;
        this.volume = 1;
        this.fadeSeconds = 0.012;
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor)
            throw new Error('WebAudio is not available.');
        this.context = new Ctor({ latencyHint: options.latencyHint || 'balanced' });
        this.gain = this.context.createGain();
        this.gain.gain.value = 1;
        this.gain.connect(this.context.destination);
        this.setMaxQueueMs(options.maxQueueMs ?? 1500);
    }
    async resume() {
        if (this.context.state !== 'running')
            await this.context.resume();
    }
    pause() {
        this.context.suspend().catch(() => undefined);
    }
    setVolume(value) {
        this.volume = Math.max(0, Math.min(1, Number(value) || 0));
        const now = this.context.currentTime;
        const param = this.gain.gain;
        this.holdGainAt(now);
        param.linearRampToValueAtTime(this.volume, now + this.fadeSeconds);
    }
    setMaxQueueMs(value) {
        this.maxQueueMs = Math.max(300, Math.min(5000, Number(value) || 1500));
        this.startupBufferMs = deriveAudioStartupBufferMs(this.maxQueueMs);
    }
    enqueue(frame) {
        if (this.context.state !== 'running')
            this.context.resume().catch(() => undefined);
        const channels = Math.max(1, frame.numberOfChannels || 2);
        const frames = Math.max(0, frame.numberOfFrames || 0);
        const sampleRate = Math.max(1, frame.sampleRate || this.context.sampleRate);
        const timestamp = typeof frame.timestamp === 'number' ? frame.timestamp : 0;
        if (!frames)
            return;
        this.enqueuedFrames += 1;
        this.lastFrameSamples = frames;
        this.lastTimestampUs = timestamp;
        const durationUs = (frames / sampleRate) * 1000000;
        const mediaGapMs = this.expectedNextTimestampUs === undefined
            ? 0
            : (timestamp - this.expectedNextTimestampUs) / 1000;
        const rawQueueMs = (this.scheduledUntil - this.context.currentTime) * 1000;
        const resetReason = decideAudioTimelineReset({
            queuedMs: rawQueueMs,
            mediaGapMs,
            maxQueueMs: this.maxQueueMs,
            hasStarted: this.expectedNextTimestampUs !== undefined
        });
        if (resetReason !== 'none') {
            if (resetReason === 'underrun')
                this.underrunCount += 1;
            this.smoothTimelineReset();
        }
        const startsNewTimeline = this.expectedNextTimestampUs === undefined;
        const audioBuffer = this.context.createBuffer(channels, frames, sampleRate);
        for (let channel = 0; channel < channels; channel += 1) {
            const data = new Float32Array(frames);
            try {
                frame.copyTo(data, { planeIndex: channel, format: 'f32-planar' });
            }
            catch {
                frame.copyTo(data, { planeIndex: channel });
            }
            audioBuffer.copyToChannel(data, channel);
        }
        const now = this.context.currentTime;
        const when = calculateAudioStartTime(now, this.scheduledUntil, this.startupBufferMs, startsNewTimeline);
        if (startsNewTimeline) {
            this.clock.reset();
            this.clock.bind(timestamp, when);
            this.fadeInAt(when);
        }
        const source = this.context.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.gain);
        source.start(when);
        this.scheduledUntil = when + audioBuffer.duration;
        this.expectedNextTimestampUs = timestamp + durationUs;
        this.sources.add(source);
        source.onended = () => {
            this.sources.delete(source);
            try {
                source.disconnect();
            }
            catch { }
        };
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
            lastTimestampUs: this.lastTimestampUs,
            timelineResetCount: this.timelineResetCount,
            underrunCount: this.underrunCount,
            startupBufferMs: this.startupBufferMs
        };
    }
    reset(smooth = true) {
        const now = this.context.currentTime;
        if (smooth && this.sources.size > 0 && this.context.state !== 'closed') {
            const fadeOutAt = now + this.fadeSeconds;
            const fadeInAt = fadeOutAt + this.fadeSeconds;
            const param = this.gain.gain;
            this.holdGainAt(now);
            param.linearRampToValueAtTime(0, fadeOutAt);
            this.stopScheduledSources(fadeOutAt);
            param.setValueAtTime(0, fadeOutAt);
            param.linearRampToValueAtTime(this.volume, fadeInAt);
            this.scheduledUntil = fadeInAt;
            this.timelineResetCount += 1;
        }
        else {
            this.stopScheduledSources(now);
            this.scheduledUntil = now;
        }
        this.clock.reset();
        this.expectedNextTimestampUs = undefined;
        this.enqueuedFrames = 0;
        this.lastFrameSamples = 0;
        this.lastTimestampUs = 0;
    }
    close() {
        this.reset(false);
        this.context.close().catch(() => undefined);
    }
    smoothTimelineReset() {
        const now = this.context.currentTime;
        const fadeOutAt = now + this.fadeSeconds;
        const fadeInAt = fadeOutAt + this.fadeSeconds;
        const param = this.gain.gain;
        this.holdGainAt(now);
        param.linearRampToValueAtTime(0, fadeOutAt);
        this.stopScheduledSources(fadeOutAt);
        param.setValueAtTime(0, fadeOutAt);
        param.linearRampToValueAtTime(this.volume, fadeInAt);
        this.clock.reset();
        this.scheduledUntil = fadeInAt + this.startupBufferMs / 1000;
        this.expectedNextTimestampUs = undefined;
        this.timelineResetCount += 1;
    }
    fadeInAt(time) {
        const param = this.gain.gain;
        param.cancelScheduledValues(time);
        param.setValueAtTime(0, time);
        param.linearRampToValueAtTime(this.volume, time + this.fadeSeconds);
    }
    holdGainAt(time) {
        const param = this.gain.gain;
        const hold = param.cancelAndHoldAtTime;
        if (typeof hold === 'function') {
            try {
                hold.call(param, time);
                return;
            }
            catch { }
        }
        const value = param.value;
        param.cancelScheduledValues(time);
        param.setValueAtTime(value, time);
    }
    stopScheduledSources(stopAt) {
        for (const source of this.sources) {
            try {
                source.stop(stopAt);
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
        this.vertexShader = null;
        this.fragmentShader = null;
        this.vertexBuffer = null;
        this.contextLost = false;
        this.handleContextLost = (event) => {
            event.preventDefault();
            this.contextLost = true;
        };
        this.handleContextRestored = () => {
            this.contextLost = false;
            this.releaseResources();
            this.init();
        };
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (!gl)
            throw new Error('WebGL context is not available.');
        this.gl = gl;
        this.canvas.addEventListener('webglcontextlost', this.handleContextLost);
        this.canvas.addEventListener('webglcontextrestored', this.handleContextRestored);
        this.init();
    }
    draw(frame) {
        if (this.contextLost || !this.program || !this.texture)
            return;
        const width = frame.displayWidth || frame.codedWidth;
        const height = frame.displayHeight || frame.codedHeight;
        if (width && height && (this.canvas.width !== width || this.canvas.height !== height)) {
            this.canvas.width = width;
            this.canvas.height = height;
        }
        const gl = this.gl;
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(this.program);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    clear() {
        if (!this.contextLost)
            this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    }
    destroy() {
        this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
        this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
        this.releaseResources();
    }
    releaseResources() {
        const gl = this.gl;
        if (this.texture)
            gl.deleteTexture(this.texture);
        if (this.vertexBuffer)
            gl.deleteBuffer(this.vertexBuffer);
        if (this.program)
            gl.deleteProgram(this.program);
        if (this.vertexShader)
            gl.deleteShader(this.vertexShader);
        if (this.fragmentShader)
            gl.deleteShader(this.fragmentShader);
        this.texture = null;
        this.vertexBuffer = null;
        this.program = null;
        this.vertexShader = null;
        this.fragmentShader = null;
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
        this.vertexShader = vertex;
        this.fragmentShader = fragment;
        const program = gl.createProgram();
        if (!program)
            throw new Error('Failed to create WebGL program.');
        gl.attachShader(program, vertex);
        gl.attachShader(program, fragment);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            const error = gl.getProgramInfoLog(program) || 'Failed to link WebGL program.';
            gl.deleteProgram(program);
            throw new Error(error);
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
        if (!buffer)
            throw new Error('Failed to create WebGL vertex buffer.');
        this.vertexBuffer = buffer;
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
        const pos = gl.getAttribLocation(program, 'a_pos');
        const uv = gl.getAttribLocation(program, 'a_uv');
        gl.enableVertexAttribArray(pos);
        gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 16, 0);
        gl.enableVertexAttribArray(uv);
        gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 16, 8);
        this.texture = gl.createTexture();
        if (!this.texture)
            throw new Error('Failed to create WebGL texture.');
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
            const error = this.gl.getShaderInfoLog(shader) || 'Failed to compile WebGL shader.';
            this.gl.deleteShader(shader);
            throw new Error(error);
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
function trimLiveAudioQueue(queue, maxDurationUs, maxSamples = 512) {
    const durationLimit = Math.max(100000, Number(maxDurationUs) || 2000000);
    const sampleLimit = Math.max(8, Math.floor(maxSamples));
    if (queue.length <= sampleLimit) {
        const first = queue[0];
        const last = queue[queue.length - 1];
        if (!first || !last || last.timestamp - first.timestamp <= durationLimit)
            return 0;
    }
    let keepFrom = queue.length - 1;
    const newest = queue[queue.length - 1]?.timestamp || 0;
    while (keepFrom > 0) {
        const span = newest - queue[keepFrom - 1].timestamp;
        if (queue.length - keepFrom >= sampleLimit || span > durationLimit)
            break;
        keepFrom -= 1;
    }
    const dropped = keepFrom;
    if (dropped > 0)
        queue.splice(0, dropped);
    return dropped;
}
function insertByTimestamp(queue, item) {
    const last = queue[queue.length - 1];
    if (!last || last.timestamp <= item.timestamp) {
        queue.push(item);
        return;
    }
    let low = 0;
    let high = queue.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (queue[middle].timestamp <= item.timestamp)
            low = middle + 1;
        else
            high = middle;
    }
    queue.splice(low, 0, item);
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
        this.videoWidth = 0;
        this.videoHeight = 0;
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
            const audio = new WebAudioPlayer({
                maxQueueMs: this.settings.audioMaxQueueMs,
                latencyHint: audioLatencyHint(this.settings.preset)
            });
            this.audio = audio;
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
        const currentTimeMs = this.currentMediaTimeMs();
        this.stats.patch({
            audioQueueMs: this.audio?.queuedMs() || 0,
            audioDecodedFrames: audioDiagnostics?.enqueuedFrames || 0,
            audioScheduledSources: audioDiagnostics?.scheduledSources || 0,
            audioFrameSamples: audioDiagnostics?.lastFrameSamples || 0,
            audioContextState: audioDiagnostics?.contextState || 'closed',
            audioTimelineResets: audioDiagnostics?.timelineResetCount || 0,
            audioUnderruns: audioDiagnostics?.underrunCount || 0,
            audioStartupBufferMs: audioDiagnostics?.startupBufferMs || 0,
            videoQueueLength: this.videoQueueLength,
            currentTimeMs,
            currentTime: currentTimeMs / 1000
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
        this.videoWidth = 0;
        this.videoHeight = 0;
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
                if (this.sourceType !== 'mp4') {
                    const dropped = trimLiveAudioQueue(this.pendingAudioSamples, this.settings.audioMaxQueueMs * 2000, 512);
                    if (dropped > 0)
                        this.stats.markAudioDropped(dropped);
                }
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
        const width = frame.displayWidth || frame.codedWidth || 0;
        const height = frame.displayHeight || frame.codedHeight || 0;
        if (width > 0 && height > 0 && (width !== this.videoWidth || height !== this.videoHeight)) {
            this.videoWidth = width;
            this.videoHeight = height;
            this.events.emit('videoSize', { width, height, aspectRatio: width / height });
        }
        this.stats.markDecoded();
        insertByTimestamp(this.renderQueue, { frame, timestamp });
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
        this.renderLoopId = requestRenderFrame(() => this.renderTick(sessionId));
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
            && (this.audio?.queuedMs() || 0) < this.settings.audioMaxQueueMs
            && (this.decoder?.audioDecodeQueueSize() || 0) < 32) {
            this.decoder?.decodeAudio(this.pendingAudioSamples.shift());
            audioBudget -= 1;
        }
        this.ensureMp4Pull();
        const videoCanContinue = canDecodeVideo(this.videoConfigured, this.pendingVideoSamples.length, this.renderQueue.length, this.decoder?.videoDecodeQueueSize() || 0, this.settings.maxRenderQueue);
        const audioCanContinue = this.audioConfigured && this.pendingAudioSamples.length > 0
            && (this.audio?.queuedMs() || 0) < this.settings.audioMaxQueueMs
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
    currentMediaTimeMs() {
        const audioTime = this.audio?.currentTimeMs();
        if (audioTime && audioTime > 0)
            return audioTime;
        if (this.videoWallClockBaseUs !== undefined && this.videoWallClockBaseMs !== undefined) {
            return Math.max(0, (this.videoWallClockBaseUs / 1000) + (performance.now() - this.videoWallClockBaseMs));
        }
        return 0;
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
        this.videoWidth = 0;
        this.videoHeight = 0;
        this.clearDecodePump();
        this.clearRenderQueue();
        try {
            this.renderer.clear();
        }
        catch { }
    }
    clearRenderQueue() {
        if (this.renderLoopId !== undefined) {
            cancelRenderFrame(this.renderLoopId);
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
function audioLatencyHint(preset) {
    if (preset === 'low-latency')
        return 'interactive';
    if (preset === 'smooth')
        return 'playback';
    return 'balanced';
}
function requestRenderFrame(callback) {
    if (typeof window.requestAnimationFrame === 'function')
        return window.requestAnimationFrame(callback);
    return window.setTimeout(() => callback(performance.now()), 16);
}
function cancelRenderFrame(id) {
    if (typeof window.cancelAnimationFrame === 'function')
        window.cancelAnimationFrame(id);
    else
        clearTimeout(id);
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
    if (h265webLoader?.url === url)
        return h265webLoader.promise;
    const promise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = url;
        script.async = true;
        script.onload = () => {
            if (window.new265webjs)
                resolve();
            else {
                script.remove();
                reject(new Error('h265web.js loaded but window.new265webjs is missing.'));
            }
        };
        script.onerror = () => {
            script.remove();
            reject(new Error(`Failed to load h265web.js runtime: ${url}. Expected vendored asset dist/h265webjs.js is missing.`));
        };
        document.head.appendChild(script);
    }).catch(error => {
        if (h265webLoader?.url === url)
            h265webLoader = undefined;
        throw error;
    });
    h265webLoader = { url, promise };
    return promise;
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
    resume() { this.instance?.play?.(); }
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

const STYLE_ID = 'tesla-player-control-styles';
function formatPlayerTime(seconds) {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const secs = value % 60;
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
        : `${minutes}:${String(secs).padStart(2, '0')}`;
}
class ControlBar {
    constructor(player) {
        this.player = player;
        this.previousVolume = 1;
        this.scrubbing = false;
        this.handleKeyDown = (event) => {
            const target = event.target;
            if (target?.tagName === 'INPUT' || target?.tagName === 'BUTTON')
                return;
            const key = event.key.toLowerCase();
            if (key === ' ' || key === 'k') {
                event.preventDefault();
                this.player.togglePlayback().catch(error => this.player.events.emit('error', error));
            }
            else if (key === 'm') {
                event.preventDefault();
                this.toggleMute();
            }
            else if (key === 'f') {
                event.preventDefault();
                this.player.fullscreen();
            }
            else if (key === 'arrowleft' || key === 'arrowright') {
                const stats = this.player.getStats();
                if (stats.duration > 0) {
                    event.preventDefault();
                    const offset = key === 'arrowleft' ? -5 : 5;
                    this.player.seek(Math.max(0, Math.min(stats.duration, stats.currentTime + offset)));
                }
            }
            this.showTemporarily();
        };
        this.handleDoubleClick = (event) => {
            if (event.target?.closest('.tesla-control-bar'))
                return;
            this.player.fullscreen();
        };
        this.showTemporarily = () => {
            this.show();
            if (this.player.getState() === 'playing')
                this.scheduleHide();
        };
        ensureStyles();
        this.container = player.getContainer();
        this.originalTabIndex = this.container.getAttribute('tabindex');
        this.element = document.createElement('div');
        this.element.className = 'tesla-control-bar';
        this.element.setAttribute('role', 'group');
        this.element.setAttribute('aria-label', 'Video controls');
        this.stateLabel = document.createElement('span');
        this.stateLabel.className = 'tesla-control-state';
        this.playButton = button('▶', '播放 / 暂停', () => this.player.togglePlayback().catch(error => this.player.events.emit('error', error)));
        this.playButton.classList.add('tesla-control-primary');
        this.stopButton = button('■', '停止', () => this.player.stop());
        this.progress = document.createElement('input');
        this.progress.className = 'tesla-control-progress';
        this.progress.type = 'range';
        this.progress.min = '0';
        this.progress.max = '1';
        this.progress.step = '0.01';
        this.progress.value = '0';
        this.progress.setAttribute('aria-label', '播放进度');
        this.progress.addEventListener('pointerdown', () => { this.scrubbing = true; });
        this.progress.addEventListener('input', () => this.updateTimePreview());
        this.progress.addEventListener('change', () => {
            this.scrubbing = false;
            this.player.seek(Number(this.progress.value));
        });
        this.time = document.createElement('span');
        this.time.className = 'tesla-control-time';
        this.time.textContent = '0:00 / 0:00';
        this.muteButton = button('🔊', '静音', () => this.toggleMute());
        this.volume = document.createElement('input');
        this.volume.className = 'tesla-control-volume';
        this.volume.type = 'range';
        this.volume.min = '0';
        this.volume.max = '1';
        this.volume.step = '0.01';
        this.volume.value = String(this.player.getVolume());
        this.volume.setAttribute('aria-label', '音量');
        this.volume.addEventListener('input', () => {
            const value = Number(this.volume.value);
            if (value > 0)
                this.previousVolume = value;
            this.player.setVolume(value);
            this.updateVolumeIcon(value);
        });
        const screenshot = button('◉', '截图', () => {
            const url = this.player.screenshot();
            if (!url)
                return;
            const link = document.createElement('a');
            link.href = url;
            link.download = `tesla-frame-${Date.now()}.png`;
            link.click();
        });
        screenshot.classList.add('tesla-control-optional');
        const fullscreen = button('⛶', '全屏', () => this.player.fullscreen());
        const spacer = document.createElement('span');
        spacer.className = 'tesla-control-spacer';
        this.element.append(this.stateLabel, this.playButton, this.stopButton, this.progress, this.time, spacer, this.muteButton, this.volume, screenshot, fullscreen);
        this.unsubscribe = this.player.on('state', () => this.refresh());
        this.timer = window.setInterval(() => this.refresh(), 250);
        this.container.addEventListener('pointermove', this.showTemporarily, { passive: true });
        this.container.addEventListener('pointerdown', this.showTemporarily, { passive: true });
        this.container.addEventListener('touchstart', this.showTemporarily, { passive: true });
        this.container.addEventListener('focusin', this.showTemporarily);
        this.container.addEventListener('keydown', this.handleKeyDown);
        this.container.addEventListener('dblclick', this.handleDoubleClick);
        if (!this.container.hasAttribute('tabindex'))
            this.container.tabIndex = 0;
        this.refresh();
    }
    destroy() {
        this.unsubscribe?.();
        if (this.timer !== undefined)
            clearInterval(this.timer);
        if (this.hideTimer !== undefined)
            clearTimeout(this.hideTimer);
        this.container.removeEventListener('pointermove', this.showTemporarily);
        this.container.removeEventListener('pointerdown', this.showTemporarily);
        this.container.removeEventListener('touchstart', this.showTemporarily);
        this.container.removeEventListener('focusin', this.showTemporarily);
        this.container.removeEventListener('keydown', this.handleKeyDown);
        this.container.removeEventListener('dblclick', this.handleDoubleClick);
        if (this.originalTabIndex === null)
            this.container.removeAttribute('tabindex');
        else
            this.container.setAttribute('tabindex', this.originalTabIndex);
        this.element.remove();
    }
    refresh() {
        const state = this.player.getState();
        const stats = this.player.getStats();
        this.playButton.textContent = state === 'playing' || state === 'loading' ? '❚❚' : '▶';
        this.playButton.title = state === 'playing' || state === 'loading' ? '暂停' : '播放';
        this.stateLabel.textContent = state === 'loading' ? '加载中…' : state === 'error' ? '播放失败' : '';
        this.stateLabel.hidden = state !== 'loading' && state !== 'error';
        const duration = Number(stats.duration) || 0;
        const current = Math.max(0, Number(stats.currentTime) || 0);
        this.progress.disabled = duration <= 0;
        this.progress.max = String(Math.max(1, duration));
        if (!this.scrubbing)
            this.progress.value = String(Math.min(current, Math.max(1, duration)));
        if (!this.scrubbing)
            this.time.textContent = `${formatPlayerTime(current)} / ${formatPlayerTime(duration)}`;
        const volume = this.player.getVolume();
        if (document.activeElement !== this.volume)
            this.volume.value = String(volume);
        this.updateVolumeIcon(volume);
        this.stopButton.disabled = state === 'idle' || state === 'stopped' || state === 'destroyed';
        if (state === 'playing')
            this.scheduleHide();
        else
            this.show();
    }
    updateTimePreview() {
        const stats = this.player.getStats();
        this.time.textContent = `${formatPlayerTime(Number(this.progress.value))} / ${formatPlayerTime(stats.duration)}`;
    }
    toggleMute() {
        const current = this.player.getVolume();
        if (current > 0) {
            this.previousVolume = current;
            this.player.setVolume(0);
        }
        else {
            this.player.setVolume(this.previousVolume || 1);
        }
        this.refresh();
    }
    updateVolumeIcon(value) {
        this.muteButton.textContent = value <= 0 ? '🔇' : value < 0.5 ? '🔉' : '🔊';
    }
    show() {
        this.element.dataset.hidden = 'false';
        if (this.hideTimer !== undefined) {
            clearTimeout(this.hideTimer);
            this.hideTimer = undefined;
        }
    }
    scheduleHide() {
        if (this.hideTimer !== undefined || this.scrubbing || this.element.contains(document.activeElement))
            return;
        this.hideTimer = window.setTimeout(() => {
            this.hideTimer = undefined;
            if (this.player.getState() === 'playing' && !this.element.contains(document.activeElement)) {
                this.element.dataset.hidden = 'true';
            }
        }, 2600);
    }
}
function button(text, label, action) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = text;
    element.title = label;
    element.setAttribute('aria-label', label);
    element.addEventListener('click', action);
    return element;
}
function ensureStyles() {
    if (document.getElementById(STYLE_ID))
        return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
.tesla-control-bar{position:absolute;left:0;right:0;bottom:0;z-index:30;display:flex;align-items:center;gap:8px;min-height:52px;padding:8px max(10px,env(safe-area-inset-right)) calc(8px + env(safe-area-inset-bottom)) max(10px,env(safe-area-inset-left));background:linear-gradient(transparent,rgba(0,0,0,.9));color:#fff;transition:opacity .2s ease,transform .2s ease;font:13px/1.2 system-ui,-apple-system,Segoe UI,sans-serif}
.tesla-control-bar[data-hidden="true"]{opacity:0;transform:translateY(8px);pointer-events:none}
.tesla-control-bar button{display:grid;place-items:center;min-width:38px;height:38px;padding:0 10px;border:0;border-radius:10px;background:rgba(255,255,255,.14);color:#fff;font:600 16px/1 system-ui;cursor:pointer;backdrop-filter:blur(8px)}
.tesla-control-bar button:hover,.tesla-control-bar button:focus-visible{background:rgba(255,255,255,.25);outline:2px solid rgba(255,255,255,.65);outline-offset:1px}
.tesla-control-bar button:disabled{opacity:.4;cursor:default}
.tesla-control-primary{background:#2563eb!important}
.tesla-control-progress{flex:1 1 180px;min-width:70px;accent-color:#3b82f6}
.tesla-control-volume{width:90px;accent-color:#3b82f6}
.tesla-control-time{white-space:nowrap;font-variant-numeric:tabular-nums;text-shadow:0 1px 2px #000}
.tesla-control-spacer{flex:0 0 2px}
.tesla-control-state{position:absolute;left:50%;bottom:58px;transform:translateX(-50%);padding:7px 12px;border-radius:999px;background:rgba(0,0,0,.72);white-space:nowrap}
@media(max-width:560px){.tesla-control-bar{gap:5px;min-height:48px;padding-top:6px}.tesla-control-bar button{min-width:36px;height:36px;padding:0 8px}.tesla-control-time,.tesla-control-optional,.tesla-control-bar>button:nth-of-type(2){display:none}.tesla-control-volume{width:62px}.tesla-control-progress{flex-basis:80px}}
@media(pointer:coarse){.tesla-control-bar button{min-width:42px;height:42px}}
`;
    document.head.appendChild(style);
}

function calculateResponsivePlayerHeight(input) {
    const width = Math.max(0, Number(input.width) || 0);
    const viewportHeight = Math.max(0, Number(input.viewportHeight) || 0);
    const aspectRatio = Number.isFinite(input.aspectRatio) && input.aspectRatio > 0 ? input.aspectRatio : 16 / 9;
    const viewportRatio = Number.isFinite(input.maxViewportHeightRatio)
        ? Math.max(0.25, Math.min(1, input.maxViewportHeightRatio))
        : 1;
    if (!width)
        return 0;
    const widthBasedHeight = width / aspectRatio;
    const viewportCap = viewportHeight ? viewportHeight * viewportRatio : widthBasedHeight;
    return Math.max(1, Math.floor(Math.min(widthBasedHeight, viewportCap)));
}
const MANAGED_STYLES = [
    'width', 'height', 'maxWidth', 'maxHeight', 'minHeight', 'overflow', 'position',
    'aspectRatio', 'touchAction', 'contain'
];
const RESPONSIVE_STYLES = [
    'width', 'height', 'maxWidth', 'maxHeight', 'minHeight', 'aspectRatio', 'touchAction', 'contain'
];
class PlayerLayoutController {
    constructor(container, options) {
        this.container = container;
        this.options = options;
        this.original = new Map();
        this.videoAspectRatio = 16 / 9;
        this.destroyed = false;
        this.update = () => {
            if (this.destroyed || !this.options.responsive)
                return;
            const fullscreen = document.fullscreenElement === this.container;
            if (fullscreen) {
                this.container.style.width = '100%';
                this.container.style.height = '100%';
                this.container.style.maxHeight = '100dvh';
                this.container.style.aspectRatio = 'auto';
                return;
            }
            const parentWidth = this.container.parentElement?.clientWidth || 0;
            const ownWidth = this.container.getBoundingClientRect().width || this.container.clientWidth || 0;
            const width = parentWidth || ownWidth;
            const viewportHeight = window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight;
            const aspectRatio = this.options.aspectRatio === 'video' ? this.videoAspectRatio : this.options.aspectRatio;
            const height = calculateResponsivePlayerHeight({
                width,
                viewportHeight,
                aspectRatio,
                maxViewportHeightRatio: this.options.maxViewportHeightRatio
            });
            if (!height)
                return;
            this.container.style.width = '100%';
            this.container.style.height = `${height}px`;
            this.container.style.maxHeight = 'calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom))';
            this.container.style.aspectRatio = String(aspectRatio);
        };
        for (const property of MANAGED_STYLES)
            this.original.set(property, container.style[property]);
        this.applyBaseStyles();
        this.observe();
        this.update();
    }
    updateOptions(values) {
        const wasResponsive = this.options.responsive;
        this.options = { ...this.options, ...values };
        if (wasResponsive && !this.options.responsive) {
            this.restoreResponsiveStyles();
            this.applyBaseStyles();
            return;
        }
        this.applyBaseStyles();
        this.update();
    }
    setVideoSize(width, height) {
        if (width > 0 && height > 0) {
            this.videoAspectRatio = width / height;
            if (this.options.aspectRatio === 'video')
                this.update();
        }
    }
    destroy() {
        if (this.destroyed)
            return;
        this.destroyed = true;
        this.observer?.disconnect();
        window.removeEventListener('resize', this.update);
        window.removeEventListener('orientationchange', this.update);
        window.visualViewport?.removeEventListener('resize', this.update);
        document.removeEventListener('fullscreenchange', this.update);
        this.restoreManagedStyles();
    }
    restoreManagedStyles() {
        for (const property of MANAGED_STYLES)
            this.container.style[property] = this.original.get(property) || '';
    }
    restoreResponsiveStyles() {
        for (const property of RESPONSIVE_STYLES)
            this.container.style[property] = this.original.get(property) || '';
    }
    applyBaseStyles() {
        var _a;
        (_a = this.container.style).position || (_a.position = 'relative');
        this.container.style.overflow = 'hidden';
        if (!this.options.responsive)
            return;
        this.container.style.maxWidth = '100%';
        this.container.style.minHeight = '0';
        this.container.style.touchAction = 'manipulation';
        this.container.style.contain = 'layout paint';
    }
    observe() {
        if (typeof ResizeObserver === 'function') {
            this.observer = new ResizeObserver(() => this.update());
            this.observer.observe(this.container.parentElement || this.container);
        }
        window.addEventListener('resize', this.update, { passive: true });
        window.addEventListener('orientationchange', this.update, { passive: true });
        window.visualViewport?.addEventListener('resize', this.update, { passive: true });
        document.addEventListener('fullscreenchange', this.update);
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
    if (jessibucaLoader?.url === scriptUrl)
        return jessibucaLoader.promise;
    const promise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = scriptUrl;
        script.async = true;
        script.onload = () => {
            if (window.Jessibuca)
                resolve();
            else {
                script.remove();
                reject(new Error('Jessibuca loaded but global constructor is missing.'));
            }
        };
        script.onerror = () => {
            script.remove();
            reject(new Error(`Failed to load Jessibuca runtime: ${scriptUrl}`));
        };
        document.head.appendChild(script);
    }).catch(error => {
        if (jessibucaLoader?.url === scriptUrl)
            jessibucaLoader = undefined;
        throw error;
    });
    jessibucaLoader = { url: scriptUrl, promise };
    return promise;
}
class TeslaPlayer {
    constructor(containerOrOptions, maybeOptions = {}) {
        var _a;
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
        this.videoWidth = 0;
        this.videoHeight = 0;
        this.on = this.events.on.bind(this.events);
        this.off = this.events.off.bind(this.events);
        const supplied = typeof HTMLElement !== 'undefined' && containerOrOptions instanceof HTMLElement
            ? { ...maybeOptions, container: containerOrOptions }
            : containerOrOptions;
        this.options = normalizePlayerOptions(supplied);
        if (!this.options.container)
            throw new Error('createTeslaPlayer requires a container element.');
        (_a = this.options.container.style).background || (_a.background = '#000');
        this.layout = new PlayerLayoutController(this.options.container, {
            responsive: this.options.responsive !== false,
            aspectRatio: this.options.aspectRatio ?? 16 / 9,
            maxViewportHeightRatio: this.options.maxViewportHeightRatio ?? 1
        });
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
        this.clearReconnectTimer();
        if (this.activeEngine !== 'none') {
            this.stopActiveEngine();
            this.activeEngine = 'none';
            this.transitionState('stopped');
        }
        this.url = url;
        this.options = normalizePlayerOptions({ ...this.options, ...options, container: this.options.container });
        this.sourceType = options.sourceType || inferSourceType(url);
        this.videoWidth = 0;
        this.videoHeight = 0;
        this.volume = this.options.volume ?? this.volume;
        this.layout.updateOptions({
            responsive: this.options.responsive !== false,
            aspectRatio: this.options.aspectRatio ?? 16 / 9,
            maxViewportHeightRatio: this.options.maxViewportHeightRatio ?? 1
        });
        this.stats.resetSession({ sourceType: this.sourceType, lastError: '' });
        this.applyWebCodecsOptions();
        this.jess?.setVolume(this.volume);
        this.hls?.setVolume(this.volume);
        this.h265?.setVolume(this.volume);
        this.syncControls();
    }
    async play(url, options = {}) {
        if (!url && Object.keys(options).length === 0 && this.state.current === 'paused') {
            await this.resume();
            return;
        }
        if (!url && Object.keys(options).length === 0 && this.state.current === 'playing')
            return;
        if (url)
            this.load(url, options);
        else if (Object.keys(options).length > 0)
            this.updateSettings(options);
        if (!this.url)
            throw new Error('Playback URL is required.');
        if (this.state.current === 'destroyed')
            throw new Error('Cannot play media after destroy().');
        this.clearReconnectTimer();
        this.reconnectAttempts = 0;
        await this.playCurrent(false);
    }
    pause() {
        if (this.state.current !== 'playing' && this.state.current !== 'loading')
            return;
        if (this.activeEngine === 'webcodecs') {
            this.hls?.pause();
            return;
        }
        if (this.activeEngine === 'h265web')
            this.h265?.pause();
        else if (this.activeEngine === 'jessibuca')
            this.jess?.pause().catch(error => this.handlePlaybackError(normalizeError(error)));
        else
            return;
        this.transitionState('paused');
    }
    async resume() {
        if (this.state.current !== 'paused')
            return;
        if (this.activeEngine === 'webcodecs') {
            await this.hls?.resume();
            return;
        }
        if (this.activeEngine === 'h265web')
            this.h265?.resume();
        else if (this.activeEngine === 'jessibuca')
            await this.jess?.play();
        if (this.getState() !== 'destroyed') {
            this.transitionState('playing');
        }
    }
    stop() {
        if (this.state.current === 'destroyed')
            return;
        this.clearReconnectTimer();
        this.reconnectAttempts = 0;
        this.stopActiveEngine();
        this.activeEngine = 'none';
        if (this.state.current !== 'stopped') {
            this.transitionState('stopped');
        }
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
        this.layout.destroy();
        this.activeEngine = 'none';
        this.guard.stop();
        this.state.transition('destroyed');
        this.events.clear();
    }
    async togglePlayback() {
        if (this.state.current === 'paused')
            await this.resume();
        else if (this.state.current === 'playing' || this.state.current === 'loading')
            this.pause();
        else
            await this.play();
    }
    getVolume() {
        return this.volume;
    }
    getContainer() {
        return this.options.container;
    }
    setRenderer(renderer) {
        this.options.renderer = renderer;
        this.applyWebCodecsOptions();
    }
    updateSettings(options) {
        this.options = normalizePlayerOptions({ ...this.options, ...options, container: this.options.container });
        this.layout.updateOptions({
            responsive: this.options.responsive !== false,
            aspectRatio: this.options.aspectRatio ?? 16 / 9,
            maxViewportHeightRatio: this.options.maxViewportHeightRatio ?? 1
        });
        this.volume = this.options.volume ?? this.volume;
        this.jess?.setVolume(this.volume);
        this.hls?.setVolume(this.volume);
        this.h265?.setVolume(this.volume);
        this.applyWebCodecsOptions();
        this.syncControls();
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
            // TeslaPlayer renders one consistent control bar for every engine.
            // Keeping Jessibuca's built-in controls enabled would create two stacked UIs.
            operateBtns: {
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
        this.transitionState('loading');
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
        this.firstFrameStart = performance.now();
        this.firstFrameSeen = false;
        this.transitionState('loading');
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
        engine.events.on('state', state => this.transitionState(state));
        engine.events.on('error', error => this.handlePlaybackError(error, true));
        engine.events.on('log', message => this.events.emit('log', message));
        engine.events.on('videoSize', size => {
            this.layout.setVideoSize(size.width, size.height);
            this.events.emit('videoSize', size);
        });
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
        bind('videoInfo', (info) => {
            const width = Number(info?.width) || 0;
            const height = Number(info?.height) || 0;
            if (width > 0 && height > 0 && (width !== this.videoWidth || height !== this.videoHeight)) {
                this.videoWidth = width;
                this.videoHeight = height;
                const size = { width, height, aspectRatio: width / height };
                this.layout.setVideoSize(width, height);
                this.events.emit('videoSize', size);
            }
            this.events.emit('log', `Video ${info?.encType || ''} ${width}x${height}`);
        });
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
        this.transitionState('playing');
    }
    handlePlaybackError(error, engineAlreadyStopped = false) {
        if (this.state.current === 'destroyed' || this.reconnectTimer !== undefined)
            return;
        const canReconnect = this.options.reconnect !== false
            && (this.sourceType === 'http-flv' || this.sourceType === 'ws-flv' || this.sourceType === 'hls')
            && this.reconnectAttempts < (this.options.reconnectMaxRetries ?? 3);
        if (!canReconnect) {
            this.fail(error, engineAlreadyStopped);
            return;
        }
        if (!engineAlreadyStopped)
            this.stopActiveEngine();
        this.activeEngine = 'none';
        this.reconnectAttempts += 1;
        this.stats.incrementReconnect();
        this.stats.patch({ lastError: error.message });
        this.events.emit('reconnect', this.reconnectAttempts);
        this.transitionState('loading');
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
    transitionState(next) {
        if (this.state.current === next)
            return;
        this.state.transition(next);
        this.events.emit('state', this.state.current);
    }
    fail(error, engineAlreadyStopped = false) {
        if (this.state.current === 'destroyed')
            return;
        this.clearReconnectTimer();
        if (!engineAlreadyStopped)
            this.stopActiveEngine();
        this.activeEngine = 'none';
        this.stats.patch({ lastError: error.message });
        this.transitionState('error');
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

if (typeof window !== 'undefined') {
    window.TeslaPlayer = TeslaPlayer;
    window.TeslaStandalonePlayer = TeslaPlayer;
    window.createTeslaPlayer = createTeslaPlayer;
}

export { TeslaPlayer, TeslaPlayer as TeslaStandalonePlayer, createTeslaPlayer, TeslaPlayer as default };
//# sourceMappingURL=main-app.js.map
