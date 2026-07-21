# 技术白皮书：浏览器内核级播放器

## 1. 目标

Tesla-VideoPlayer 希望在浏览器中掌握“拉流、解封装、解码、时钟、渲染、音频、
错误恢复”完整链路，而不是把核心行为交给 HTML `video` 或 MSE。

Tesla WebCodecs 链路的核心目标：

- 不创建 HTML `video` 标签；
- 不使用 MSE；
- 能观察和控制缓冲、解码、丢帧、同步和错误；
- 能扩展 WebGL/WebGPU 后处理和 AI 图像处理；
- 快速切流、停止和错误后不存在旧会话污染。

## 2. 当前实际架构

```text
输入源：HLS / MP4 / HTTP-FLV / WS-FLV
        ↓
Worker：网络 IO、播放列表、AES、TS/FLV/MP4 解封装
        ↓ typed postMessage + Transferable
Main：WebCodecs VideoDecoder / AudioDecoder
        ↓                         ↓
Canvas2D / WebGL             WebAudio
        \_________________________/
             音频主时钟与视频调度
```

FLV 的 `auto/wasm` 模式另有 Jessibuca WASM 路线。HLS/MP4 目前只支持 WebCodecs。

## 3. 线程与职责

### 主线程

- 公开 API 和播放器状态；
- 引擎路由与自动重连；
- WebCodecs 配置和解码提交；
- Canvas/WebGL 渲染；
- WebAudio 调度和 A/V 同步；
- 控制条、Stats、NoVideoGuard。

### Worker

- HTTP/Range/WebSocket 拉流；
- HLS 播放列表和 TS 分片；
- AES-128 解密；
- FLV、TS、MP4 解封装；
- 生成 codec config 和压缩样本；
- MP4 下载进度与 HLS discontinuity 事件。

Worker 不管理 DOM，不创建解码器，不负责渲染。

## 4. 会话隔离

每次播放都有递增的 generation ID。新播放开始时先让旧 generation 失效，
再释放旧 Worker、Decoder、AudioContext、定时器和队列。

所有异步回调都必须携带旧 generation 并在执行前检查：

- Worker 消息；
- `isConfigSupported/configure` Promise；
- `VideoFrame` / `AudioData` 回调；
- AudioContext resume；
- decode/render timer。

这样 A 流的延迟回调不会修改已经开始的 B 流。

## 5. MP4 增量链路

MP4 按 2 MiB 顺序 Range 下载；服务端不支持 Range 时改为读取 HTTP 200 的
流式 body。每个块直接带 `fileStart` 交给 MP4Box。

内存控制：

- 不组装第二份完整文件；
- Worker 有 pending sample 高水位；
- 主线程按 credit 拉取样本；
- 样本转移后调用 `releaseUsedSamples()`；
- 主线程压缩样本、Decoder 和渲染队列继续限流。

`moov` 在文件头时可边下载边开始播放；`moov` 在文件尾时仍需要先下载到元数据。

## 6. HLS 链路

当前支持 MPEG-TS H.264/AAC：

```text
m3u8 → 分片 → AES-128（可选）→ TS/PES → H.264/AAC samples
```

`EXT-X-DISCONTINUITY` 会触发新的解码 epoch：

- 重建 WebCodecs Decoder；
- 清空压缩和解码队列；
- 关闭等待渲染的 VideoFrame；
- 重置 WebAudio 和时钟；
- 等待新 codec config 和关键帧。

当前不支持 SAMPLE-AES、fMP4/CMAF、BYTERANGE 和多音轨自适应。

## 7. 缓冲与背压

背压不是单一队列，而是多层共同工作：

1. MP4 Worker credit 和高水位；
2. 实时压缩视频队列上限；
3. `VideoDecoder.decodeQueueSize`；
4. `AudioDecoder.decodeQueueSize`；
5. 每次 decode tick 的批量上限；
6. decoded render queue 上限；
7. WebAudio 已排队时长上限。

实时视频积压时从关键帧重新开始，避免把不可解码的 delta 帧留在队列中。

## 8. 时间与同步

- TS PTS/DTS 转为微秒；时间戳 0 是合法值。
- 有音频时以 WebAudio 调度后的媒体时间为主时钟。
- 无音频或音频未就绪时使用视频首帧与墙钟建立临时基线。
- 视频过早则等待，超过 late threshold 则关闭并计为 dropped frame。

## 9. 错误和恢复

Fatal error 先终止当前 generation，再发出 `error`。外层 `TeslaPlayer` 对
HTTP-FLV、WS-FLV 和 HLS执行统一重连策略：停止当前引擎、增加重连计数、按尝试
次数延迟，然后启动全新会话。

MP4 点播错误不会自动从头重播，以保持行为确定。

## 10. 当前边界

- HLS/MP4 没有 WASM 软件解码桥接；
- Tesla WebCodecs FLV 主要支持 H.264/AAC；
- MP4 音频要求 AAC；
- h265web.js 缺少完整运行资产，仍为实验功能；
- 未实现倍速；
- 尚未使用 OffscreenCanvas、AudioWorklet 和 WebGPU。

## 11. 后续方向

- fMP4/CMAF HLS、BYTERANGE、音频 rendition 和 ABR；
- 类型化 WASM decoder bridge；
- AudioWorklet 降低音频调度抖动；
- OffscreenCanvas/WebGPU；
- 更完整的浏览器端集成测试和性能基准；
- DASH、WebRTC 数据通道和更多音视频编码格式。
