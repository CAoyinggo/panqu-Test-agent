# Panqu AI DevTest — 验真规约与金融对账白皮书 (Verification & Financial Spec)

DevTest 坚持**事实第一、客观独立、Fail-Closed**原则。本规约详细界定物理媒体验真深度、三大金融安全不变量以及会话鉴权体系。

---

## 1. 物理产物容器检验规范

### 1.1 ISO-14496 MP4 容器结构解构
DevTest 杜绝“HTTP 200 即代表成功”的假象，深入二进制文件结构：
- **顶级与嵌套 Box 树遍历**：
  - `ftyp`：文件类型标识与兼容品牌（Compatible Brands）核查；
  - `moov`：电影元数据主容器；
  - `mvhd`：解析时间刻度（timescale）与播放时长（duration），计算真实视频秒数；
  - `trak` / `mdia` / `minf` / `stbl`：音视频轨道物理参数校验；
  - `tkhd`：解析视频画面实际像素宽高（width & height）；
  - `mdat`：媒体样本数据实体存在性核查。

### 1.2 Faststart 与尾部 moov 智能切片
- 标准流媒体文件的 `moov` 位于头部（Faststart）。
- 万相 Wan3.0 等模型渲染出的视频通常将 `moov` 写入文件末尾。
- DevTest 发送带有 `bytes=-65536` 的 HTTP Range 切片请求，动态解析尾部 64KB 结构，避免将尾部 moov 文件误判为损坏文件。

### 1.3 图片物理结构提取
- **PNG**：8 字节 Magic Header (`89 50 4E 47 0D 0A 1A 0A`) 校验，解析首个 IHDR 数据块获取物理像素宽高与色深。
- **JPEG**：扫描 SOF0 标记提取几何分辨率。
- **WEBP**：解构 RIFF/WEBP 容器及 VP8/VP8L/VP8X 块提取尺寸。

### 1.4 诚实声明 (零帧虚构原则)
> [!WARNING]
> DevTest 现阶段未接入重型视频逐帧像素解码器 (如 ffmpeg 或 OpenCV)。
> 系统对容器物理格式、元数据、时长、尺寸与媒体流数据块的合法性负责，校验结果中的 `actualDecoded` 固定返回 `null`，坚决不虚构画面瑕疵或逐帧画质结论。

---

## 2. 计费流水与三大金融安全不变量

### 2.1 数据源对账
DevTest 依赖两处真实数据源：
1. **FastAdmin 后台记账流水**：查询 `AdminScore` 日志；
2. **用户端消费明细接口**：调用 `/aivideo/v2/billing/apiPersonalRecords` 接口拉取与该任务 ID 强绑定的流水记录。

### 2.2 三大金融安全不变量 (Financial Invariants)
1. **防重复扣费 (`antiDoubleBilling`)**：
   - 单个任务在正常生成终态下，有效预扣费记录数必须严格等于 1。
2. **失败净扣归零 (`netChargeZero`)**：
   - 当任务处于 `FAILED` / `TIMEOUT` 等非成功终态时，若存在扣费流水，必须存在对应的退款冲正流水，任务净扣积分（`netDeducted`）必须严格等于 0。
3. **退款幂等核销 (`refundIdempotency`)**：
   - 同一笔失败任务的退款冲正记录不得重复生成。

---

## 3. 会话解析优先级 (`autoSession`)

未显式传入 `sessionFile` 时，内核按以下严格优先级定位会话文件：
1. 当前工作目录：`./session.json`
2. 项目/用户配置目录：`./.panqu/session.json`
3. 环境变量：`process.env.PANQU_SESSION_COOKIES_FILE`
4. **阻断拦截**：若以上路径均未发现有效凭据，系统立即阻断执行（Fail-Closed），绝不向真实环境发送未受控请求。
