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
        this.hardResetQueueMs = Math.max(this.targetQueueMs * 3, this.targetQueueMs + 3000);
    }
    enqueue(frame) {
        if (this.context.state !== 'running')
            this.context.resume().catch(() => undefined);
        const channels = frame.numberOfChannels || 2;
        const frames = frame.numberOfFrames || 0;
        const sampleRate = frame.sampleRate || this.context.sampleRate;
        const timestamp = typeof frame.timestamp === 'number' ? frame.timestamp : 0;
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
            ? Math.min(1.08, 1 + ((queueMs - this.targetQueueMs) / Math.max(this.targetQueueMs, 1)) * 0.04)
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
        const chunk = new window.EncodedVideoChunk({
            type: sample.key ? 'key' : 'delta',
            timestamp: sample.timestamp,
            duration: sample.duration,
            data: sample.data
        });
        this.videoDecoder.decode(chunk);
    }
    decodeAudio(sample) {
        if (!this.audioDecoder || this.audioDecoder.state === 'closed')
            return;
        const chunk = new window.EncodedAudioChunk({
            type: 'key',
            timestamp: sample.timestamp,
            duration: sample.duration,
            data: sample.data
        });
        this.audioDecoder.decode(chunk);
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

function detectCapability(canvas) {
    const webCodecsVideo = typeof globalThis.VideoDecoder === 'function';
    const webCodecsAudio = typeof globalThis.AudioDecoder === 'function';
    const webAudio = typeof globalThis.AudioContext === 'function' || typeof globalThis.webkitAudioContext === 'function';
    let webGL = false;
    try {
        const probe = canvas || document.createElement('canvas');
        webGL = !!(probe.getContext('webgl') || probe.getContext('experimental-webgl'));
    }
    catch {
        webGL = false;
    }
    const supported = webCodecsVideo && webCodecsAudio && webAudio;
    const reason = supported ? undefined : 'This browser must support WebCodecs VideoDecoder, WebCodecs AudioDecoder, and WebAudio.';
    return { webCodecsVideo, webCodecsAudio, webAudio, webGL, supported, reason };
}

// Guardrail for the project rule that playback must never create video tags.
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
        if (this.observer)
            this.observer.disconnect();
        this.observer = undefined;
    }
}

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
                // User listeners must not break playback internals.
            }
        }
    }
    clear() {
        this.listeners = {};
    }
}

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
        return this.state === 'loading' || this.state === 'playing';
    }
}

class PlayerStatsTracker {
    constructor() {
        this.stats = {
            decoderType: 'none',
            rendererType: 'none',
            videoTagCount: 0,
            canvasCount: 0,
            fps: 0,
            decodedFrames: 0,
            droppedFrames: 0,
            audioQueueMs: 0,
            videoQueueLength: 0,
            firstFrameTimeMs: 0,
            currentTimeMs: 0
        };
        this.frameTicks = 0;
        this.lastFpsAt = performance.now();
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
        this.patch({
            videoTagCount: document.querySelectorAll('video').length,
            canvasCount: document.querySelectorAll('canvas').length
        });
        return { ...this.stats };
    }
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

class TeslaStandalonePlayer {
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
        this.videoConfigured = false;
        this.audioConfigured = false;
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
        this.canvas.style.display = 'block';
        this.canvas.style.objectFit = 'contain';
        this.canvas.style.background = '#000';
        options.container.appendChild(this.canvas);
        this.updateSettings(options);
        this.renderer = this.createRenderer(options.renderer || 'webgl');
        this.stats.patch({ rendererType: this.renderer.type });
        this.guard.start(count => this.fail(new Error(`video elements are forbidden, found ${count}.`)));
    }
    async play(url) {
        if (!url)
            throw new Error('HTTP-FLV URL is required.');
        this.stop();
        this.stopped = false;
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
        this.worker = new Worker(this.options.workerUrl || new URL('./http-flv-worker.js', import.meta.url), { type: 'module' });
        this.worker.onmessage = event => this.handleWorkerEvent(event.data);
        this.worker.onerror = event => this.fail(new Error(event.message || 'HTTP-FLV worker failed.'));
        const isHls = /\.m3u8(\?|$)/i.test(url);
        this.worker.postMessage({
            type: isHls ? 'open-hls' : 'open-http-flv',
            url,
            liveStartSegmentCount: this.settings.liveStartSegmentCount,
            liveSegmentBatch: this.settings.liveSegmentBatch
        });
    }
    pause() {
        this.worker?.postMessage({ type: 'pause' });
        this.audio?.pause();
        this.state.transition('paused');
        this.events.emit('state', this.state.current);
    }
    async resume() {
        await this.audio?.resume();
        this.worker?.postMessage({ type: 'resume' });
        this.state.transition('playing');
        this.events.emit('state', this.state.current);
    }
    stop() {
        this.stopped = true;
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
        this.pendingVideoSamples = [];
        this.pendingAudioSamples = [];
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
        this.stats.patch({
            audioQueueMs: this.audio?.queuedMs() || 0,
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
                    const samples = this.pendingAudioSamples.splice(0);
                    for (const sample of samples)
                        this.decoder?.decodeAudio(sample);
                }).catch(error => this.fail(error));
            }
            else if (message.type === 'video-sample') {
                this.videoQueueLength += 1;
                this.pendingVideoSamples.push(message);
                if (this.videoConfigured)
                    this.ensureDecodePump();
            }
            else if (message.type === 'audio-sample') {
                if (this.audioConfigured)
                    this.decoder?.decodeAudio(message);
                else
                    this.pendingAudioSamples.push(message);
            }
            else if (message.type === 'stats') {
                this.stats.patch({ videoTagCount: message.videoTagCount });
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
        this.renderLoopId = requestAnimationFrame(() => this.renderTick());
    }
    ensureDecodePump() {
        if (this.decodePumpId !== undefined)
            return;
        this.decodePumpId = requestAnimationFrame(() => this.decodeTick());
    }
    decodeTick() {
        this.decodePumpId = undefined;
        if (this.stopped || !this.videoConfigured)
            return;
        let budget = this.settings.decodeBatchSize;
        while (budget > 0 && this.pendingVideoSamples.length > 0 && this.renderQueue.length < 150) {
            const sample = this.pendingVideoSamples.shift();
            this.decoder?.decodeVideo(sample);
            budget -= 1;
        }
        if (this.pendingVideoSamples.length > 0)
            this.ensureDecodePump();
    }
    renderTick() {
        this.renderLoopId = undefined;
        if (this.stopped) {
            this.clearRenderQueue();
            return;
        }
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
    }
    videoDelayMs(timestamp) {
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
            cancelAnimationFrame(this.renderLoopId);
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
            cancelAnimationFrame(this.decodePumpId);
            this.decodePumpId = undefined;
        }
    }
}

window.TeslaStandalonePlayer = TeslaStandalonePlayer;
window.createTeslaPlayer = function (opts) {
    return new TeslaStandalonePlayer(opts);
};

export { TeslaStandalonePlayer };
//# sourceMappingURL=index.js.map
