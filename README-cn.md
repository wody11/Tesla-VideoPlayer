# Tesla-VideoPlayer

Tesla-VideoPlayer 是一个 no-video 播放器项目，现已参考 Jessibuca 开源版的成熟播放器架构重构，并整体按 GPL-3.0 发布。

## 来源与许可证

本项目基于 Jessibuca 开源版架构改造：

- Jessibuca 仓库：https://github.com/langhuihui/jessibuca
- Jessibuca 许可证：GPL-3.0
- 本项目许可证：GPL-3.0
- 第三方说明：见 `THIRD_PARTY_NOTICES.md`
- Jessibuca 运行产物已迁入：`vendor/jessibuca-runtime/`
- Jessibuca 源码快照已迁入：`vendor/jessibuca-src/`
- h265web.js 包快照已迁入：`vendor/h265webjs/`

## 播放目标

默认播放链路不使用 HTML `video` 标签，不使用 MSE：

`MP4 / HLS / HTTP-FLV / WS-FLV -> Worker 拉流与解封装 -> WebCodecs 或 WASM -> Canvas/WebGL -> WebAudio`

如果能力未接通，代码会显示明确错误或 TODO，不会静默退回 video 标签。

## 新入口

```ts
import { createTeslaPlayer } from './dist/index.js';

const player = createTeslaPlayer(document.querySelector('#player')!, {
  decoderMode: 'auto',
  renderer: 'webgl',
  controls: true
});

player.load('https://example.com/live.flv');
await player.play();
```

## API

- `load(url, options)`
- `play()`
- `pause()`
- `resume()`
- `stop()`
- `destroy()`
- `seek(time)`
- `setVolume(volume)`
- `setPlaybackRate(rate)`
- `screenshot()`
- `fullscreen()`
- `getStats()`
- `getState()`
- `on(event, handler)`
- `off(event, handler)`

## 支持状态

- HTTP-FLV、WS-FLV：H.264 + AAC，Jessibuca WASM 解码后渲染到 Canvas/WebGL
- HLS/m3u8 点播与直播：MPEG-TS H.264/AAC -> WebCodecs/WebAudio，支持主列表、AES-128、暂停/续播和点播 seek；SAMPLE-AES 暂不支持
- MP4 点播：ISO-BMFF 解封装 -> WebCodecs/WebAudio，支持 H.264/H.265/AV1/VP9 视频（以浏览器 WebCodecs 能力为准）、AAC 音频、暂停/续播和按秒 seek
- 全部默认链路均不创建 `video` 标签，不使用 MSE；播放时 `NoVideoGuard` 会持续检查
- WASM：已保留 Jessibuca 式 fallback 架构和 TODO，完整 bridge 尚未接通
- H.265/G711：等待 WASM bridge 完成后接入
- h265web.js：只做研究和显式实验入口，不默认启用；npm 包缺少实际 `dist/h265webjs.js`/wasm 运行资产，补齐后才可测试

浏览器要求：MP4/HLS 主链路需要 WebCodecs、WebAudio、Worker 与 Canvas/WebGL。跨域媒体地址必须由服务端返回允许 CORS 的响应头。MP4 使用并发 Range 分块下载并在 Worker 中组装后解封装；边下边播的渐进式 sample 提取仍待优化。

## 构建

```bash
npm install
npm run build
```

构建产物位于 `dist/`，包括 `dist/index.js` 与 worker 入口。
