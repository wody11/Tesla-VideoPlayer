# Tesla-VideoPlayer

一款**不依赖 `<video>`/MSE** 的播放器内核：
**Worker 内部解复用** → **主线程 WebCodecs 解码** → **Canvas/WebGL 渲染** + **WebAudio 同步**。
面向 HLS/MP4/FLV 等流的“轻内核、可插拔”实现。

> 适合需要更高可控性（精准时钟、画面/音频管线完全自管、无 `<video>` 黑箱）的场景。

---

<p align="center">
  <img alt="status" src="https://img.shields.io/badge/status-alpha-orange">
  <img alt="webcodecs" src="https://img.shields.io/badge/WebCodecs-required-blue">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green">
</p>

## ✨ 特性亮点

* **Worker 解复用**：在 Worker 侧解析 HLS/TS/MP4/FLV，降低主线程阻塞。
* **原生 WebCodecs 解码**：视频 `VideoDecoder`、音频 `AudioDecoder`，可选硬件加速。
* **Canvas/WebGL 渲染**：默认 2D，支持切换 WebGL 渲染器，便于后续做色彩/缩放优化。
* **WebAudio 主钟同步**：以音频为主时钟，视频按 PTS 对齐渲染；音频未建时支持 **PCR/视频墙钟回退**。
* **AVCC/AnnexB 自适应**：自动识别并在关键帧**注入 SPS/PPS**，减少“偶发黑屏/花屏”。
* **首屏引导**：首个关键帧直送 + 邻近少量 delta 帧，**更快出画**。
* **热重配**：音频采样率/声道变化时**热重配** `AudioDecoder`，不中断。
* **可调调度参数**：前瞻/丢帧窗口、in-flight 深度、引导窗口等**运行时可调**。
* **卡顿检测**：按“已排程音频提前量 & 视频队列”评估 `buffering/playing` 事件。
* **软解回退占位**：预留 `ffmpeg.wasm` 接口（未默认开启）。

> 这些都是许多开源播放器未覆盖或做得不够稳的“硬核细节”。

---

## 🧠 架构一览

```
              Fetch/Playlist/HLS
                   │
                   ▼
             ┌─────────────┐
             │   Worker     │  ← 解复用/时戳归一化/分段调度
             └─────┬───────┘
                   │ postMessage(sample / config / events)
                   ▼
        ┌──────────────────────────┐
        │        主线程            │
        │  WebCodecs: Video/Audio  │
        │  Canvas/WebGL + WebAudio │
        └──────────────────────────┘
                   │
                   ▼
           Canvas  &  AudioContext
```

---

## 📦 安装与示例

```bash
# 作为源码依赖（建议 pnpm/yarn 亦可）
npm i
npm run build

# 本地起个静态服务查看 demo（任选）
npx http-server .
# 或用你自己的 dev server
```

最小可运行示例（TypeScript）：

```ts
import { PlayerCore } from './player-core';

const canvas = document.getElementById('video') as HTMLCanvasElement;
const player = new PlayerCore({
  canvas,
  renderer: '2d', // or 'webgl'
  enableSoftwareFallback: false, // 软解回退占位
});

// 可选：调起步位（仅 HLS VOD）
player.setStartPositionMs(0);

// 监听事件
player.on('playing', () => console.log('playing'));
player.on('buffering', () => console.log('buffering'));
player.on('ended', () => console.log('ended'));
player.on('error',  (e: any) => console.error(e));

// 载入并播放
await player.load('https://example.com/path/index.m3u8'); // .m3u8 / .mp4 / .flv
await player.play();
```

> ⚠️ 注意：Worker 文件默认从 `dist/index.js` 或 `worker.js` 加载。生产环境请确保**同源可访问**（或正确的 CORS/路径）。

---

## 🛠️ API 速览

### 构造

```ts
new PlayerCore({
  canvas: HTMLCanvasElement,
  renderer?: '2d'|'webgl',
  videoLookAheadMs?: number,   // 默认 ~80ms
  dropWindowMs?: number,       // 默认 ~120ms
  leadWindowMs?: number,       // 默认 ~200ms（LIVE 建议更大）
  maxVideoInFlight?: number,   // 默认 6
  maxVideoQueue?: number,      // 默认 180
  usePcrBeforeAudio?: boolean, // 默认 true
  enableSoftwareFallback?: boolean, // 软解占位
  stallAudioMinAheadS?: number, // 缓冲判定：有音频时最小提前量
  stallNoAudioIdleMs?: number,  // 无音频时空闲阈值
});
```

### 基本控制

```ts
await player.load(url);     // 载入（HLS/MP4/FLV）
await player.play();        // 播放
await player.pause();       // 暂停
await player.stop();        // 停止并清理
await player.seek(ms);      // 定位（HLS 走 worker seek）
player.setPlaybackRate(1.25);
player.setMuted(true);
player.setVolume(0.8);
player.goLive();            // HLS 直播追尾
```

### 渲染/管线

```ts
player.attachCanvas(newCanvas, 'webgl'); // 切换画布/渲染器
player.setRenderer('2d'|'webgl');
```

### 调优参数（运行时可改）

```ts
player.setLookAheadMs(100);
player.setDropWindowMs(120);
player.setLeadWindowMs(120);       // VOD 推荐 80~120ms
player.setMaxVideoInFlight(6);
player.setMaxVideoQueue(180);
player.setStallThresholds(0.03, 500);
player.setBootstrapFeed(500, 20);  // 首屏引导窗口/帧数
player.setUsePcrBeforeAudio(true);
player.setContinuousTimeline(true); // UI 连续时间轴
```

### 查询

```ts
player.getStats();           // { framesDrawn, framesDropped, videoQueue }
player.getSeekable();        // { startMs, endMs, isLive }
player.getCurrentTimeMs();   // 当前时间（受连续时间轴影响）
player.getDurationMs();      // 总时长（VOD）
player.getBufferState();     // { audioAheadS, videoQueued, ... }
player.getPlaybackRate();
player.getMuted();
player.getVolume();
player.getVideoQueueSize();
player.getAudioConfiguredInfo(); // { sampleRate, channels }
player.getVideoDriftUs();    // 相对音频主钟的帧漂移
player.isBuffering();
```

### 事件

* `playing`：缓冲满足/开始渲染。
* `buffering`：欠缓冲/等待。
* `ended`：播完或到流尾。
* `error`：解码/渲染/网络等错误。

---

## 🔧 Worker 通信（约定）

* `openHLS | openFLV | open (mp4-url) | openMP4(init)`：打开流/资源。
* `fetchSegment`：按需拉取分片（HLS）。
* `seek`：定位（支持 VOD / 直播追尾）。
* 上行（主线程接收）：

  * `ready-mp4` / `stream-info` / `config-update`
  * `sample(kind='audio'|'video', {ts,dts,pcr,dur,key,data})`
  * `hls-playlist` / `hls-pos` / `duration`
  * `buffering` / `playing` / `eos` / `log` / `discontinuity`

> 时间戳统一在 Worker 侧**归一化为微秒**并对齐 epoch，降低主线程对齐复杂度。

---

## 🧪 浏览器支持（简述）

* **Chromium 系**（Chrome/Edge/Opera 等）启用 WebCodecs 的现代版本。
* Safari 16+ 部分可用（细节以实际测试为准）。
* Firefox 当前默认未启用 WebCodecs（需自行评估/实验）。

> 建议生产前针对你的目标机型做一轮覆盖测试。

---

## 🚀 调优建议（经验值）

| 场景        | lookAheadMs | dropWindowMs | leadWindowMs | inFlight |
| --------- | ----------: | -----------: | -----------: | -------: |
| VOD       |      80–120 |      100–140 |   **80–120** |      4–6 |
| LIVE（低延迟） |      60–100 |       80–120 |  **180–240** |      3–5 |
| 老设备/弱 GPU |     100–160 |      140–200 |      120–160 |      2–4 |

* 首屏阶段可临时把 `leadWindowMs` 放大，稳态后下调，兼顾“快出画与唇不同步”。
* 若 UI 压力大，优先使用 `renderer: 'webgl'`。

---

## 🧩 常见问题

**Q: 只有声音/没有画面，时间也不走？**

* 确认流里**有关键帧**并被送达（日志打开 `window.__DEMO_DEBUG = true`）。
* 检查 CORS/Range 是否允许分段读取。
* 开启 `usePcrBeforeAudio=true`，让音频未建时用 PCR/视频墙钟**临时驱动时钟**。
* 确保 `play()` 时 `AudioContext.resume()` 被调用（需用户手势/HTTPS 环境）。

**Q: HLS 一次把所有分片都拉了？**

* Demo 默认串行拉取作演示。生产请实现“**按需拉取**”（前瞻 1–3s）与 **ABR**。

**Q: 颜色/清晰度发灰？**

* 试用 `renderer: 'webgl'` 并在渲染器里加 BT.709/限幅映射（TODO 示例）。

---

## 🗺️ Roadmap

* [ ] ABR（自适应码率，基于吞吐/缓冲）
* [ ] WebGL 渲染器（色彩空间/缩放器/锐化）
* [ ] OffscreenCanvas + Worker 渲染
* [ ] `ffmpeg.wasm` 软解回退（至少音频）
* [ ] 字幕（WebVTT/ASS）与外挂音轨
* [ ] 录制/截图/滤镜链
* [ ] DRM（EME/ClearKey 等）

---

## 🤝 贡献

欢迎提交 Issue/PR：

* 复现步骤（URL/片段特征/浏览器版本）
* 控制台与 `__DEMO_DEBUG` 日志
* `getStats()` 与 `getBufferState()` 截图

---

## 📜 许可

[MIT](./LICENSE)

---

