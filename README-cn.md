# Tesla-VideoPlayer

Tesla-VideoPlayer 是一个尽量把播放链路掌握在应用自身手里的浏览器播放器。
Tesla WebCodecs 链路在 Worker 中完成拉流和解封装，在主线程用 WebCodecs 解码，
再通过 Canvas/WebGL 和 WebAudio 输出。该链路不依赖 HTML `video` 标签，也不使用 MSE。

项目同时内置 Jessibuca 运行时，用于 FLV 的 WASM 软件解码。

## 主要能力

- HTTP-FLV 和 WebSocket-FLV。
- HLS 点播/直播：MPEG-TS H.264/AAC、AES-128、主列表、点播 seek、
  `EXT-X-DISCONTINUITY` 解码链路重置。
- MP4 分块下载并增量送入 MP4Box 解封装，不再在 Worker 中复制整部文件。
- WebCodecs 解码，Canvas2D/WebGL 渲染，WebAudio 输出。
- session/generation 会话隔离，快速切换时旧 Worker 和旧 Decoder 回调不会污染新会话。
- 压缩样本、Decoder、渲染和音频队列都有边界与背压控制。
- FLV/HLS 使用统一自动重连策略。
- 按可用宽度计算高度并受可视浏览器高度限制，支持横屏、竖屏和真实视频比例。
- 统一的移动端控制栏、键盘快捷键、截图、全屏、运行统计，以及仅作用于播放器容器的 NoVideoGuard。
- 连续 WebAudio 时间线、显式浮点平面转换、队列封顶和淡入淡出重置，降低爆音、卡顿和音画漂移。

## 播放路由

| 媒体类型 | `decoderMode` | 实际链路 |
|---|---|---|
| HLS | `auto`、`webcodecs` | Worker 解封装 → WebCodecs → Canvas/WebGL → WebAudio |
| MP4 | `auto`、`webcodecs` | 增量下载 → MP4Box → WebCodecs → Canvas/WebGL → WebAudio |
| HTTP/WS FLV | `auto`、`wasm` | Jessibuca WASM → Canvas/WebGL → WebAudio |
| HTTP/WS FLV | `webcodecs` | Worker FLV 解封装 → WebCodecs → Canvas/WebGL → WebAudio |
| 实验性 H.265 | 显式启用 | 依赖外部补齐 h265web.js 运行文件和 WASM 资产 |

HLS/MP4 不支持 `decoderMode: "wasm"`，因为目前还没有完成适用于这些容器的
类型化软件解码桥接。

## 运行要求

WebCodecs 链路要求浏览器支持：

- `VideoDecoder`、`AudioDecoder`；
- Worker、WebAudio、Canvas2D 或 WebGL；
- 媒体服务器允许跨域访问；
- MP4 服务端最好支持 Range 请求。

请通过 HTTP(S) 访问构建产物，不建议直接使用 `file://` 打开。

## 安装、测试和构建

```bash
npm ci
npm test
npm run typecheck
npm run build
```

主要构建产物：

- `dist/index.js`：播放器公开 API；
- `dist/worker-entry.js`：唯一有效的 Tesla Worker 入口；
- Jessibuca 运行资产会复制到 `dist/`。

## 快速使用

```ts
import { createTeslaPlayer } from './dist/index.js';

const container = document.querySelector<HTMLElement>('#player');
if (!container) throw new Error('找不到播放器容器');

const player = createTeslaPlayer(container, {
  decoderMode: 'auto',
  renderer: 'webgl',
  fitMode: 'contain',
  controls: true,
  autoplay: false,
  preset: 'balanced',
  volume: 0.8,
  reconnect: true,
  reconnectMaxRetries: 3,
  reconnectDelayMs: 1000,
  responsive: true,
  aspectRatio: 'video',
  maxViewportHeightRatio: 0.9
});

player.on('state', state => console.log('状态', state));
player.on('error', error => console.error(error));
player.on('reconnect', attempt => console.log('第几次重连', attempt));

player.load('https://example.com/live.m3u8', { sourceType: 'hls' });
await player.play();
```

对于没有扩展名、带签名参数或接口转发的 URL，建议明确填写 `sourceType`。
否则普通 HTTP(S) URL 默认会被识别为 HTTP-FLV。

## 公开 API

主要方法：

- `load(url, options?)`
- `play(url?, options?)`
- `pause()` / `resume()` / `togglePlayback()` / `stop()` / `destroy()`
- `seek(seconds)`：仅 MP4 和 HLS 点播
- `setVolume(0..1)` / `getVolume()`
- `screenshot()`
- `fullscreen()`
- `getState()` / `getStats()` / `getContainer()`
- `setRenderer()` / `updateSettings()`
- `on(event, listener)` / `off(event, listener)`

`setPlaybackRate()` 目前只会输出“不支持”的日志，不会真的修改播放速度。

完整配置、事件和 Stats 字段请看 [docs/api.md](docs/api.md)。

## 当前限制

- HTTP-FLV / WS-FLV：H.264 + AAC。
- HLS：MPEG-TS H.264 + AAC；暂不支持 SAMPLE-AES、fMP4/CMAF、
  `EXT-X-MAP` 和 BYTERANGE 列表。
- MP4：视频支持范围取决于浏览器 WebCodecs，当前音频要求 AAC。
- h265web.js 仍为实验性功能，因为当前 vendored 包缺少完整浏览器运行文件和 WASM。
- 暂不支持播放倍速。

## 文档索引

- [API 说明](docs/api.md)
- [架构说明](docs/architecture.md)
- [开发指南](docs/development.md)
- [播放策略](docs/playback-strategy.md)
- [Jessibuca 迁移说明](docs/jessibuca-migration.md)
- [H.265 集成研究](docs/h265web-study.md)
- [中文技术白皮书](docs/technical-whitepaper-cn.md)
- [变更记录](CHANGELOG.md)
