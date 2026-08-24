<p align="center">
  <img src="docs/assets/cover.jpg" alt="dsh-file-attach — Files in. Context ready." width="100%">
</p>

# dsh-file-attach

<p>
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

[![CI](https://github.com/lucadxingg/unified-file-reader/actions/workflows/ci.yml/badge.svg)](https://github.com/lucadxingg/unified-file-reader/actions/workflows/ci.yml)
[![GitHub release](https://img.shields.io/github/v/release/lucadxingg/unified-file-reader)](https://github.com/lucadxingg/unified-file-reader/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/topic-dsh--plugin-6f5cff)](https://github.com/topics/dsh-plugin)

`dsh-file-attach` 是一个由宿主端和网页端组成的 DSH 文件附件插件。它接受
配置大小限制内的任意非空文件，把支持的文档提取为模型可读文本，并将原文件
保存在会话工作区之外。所选模型明确支持图片输入时，PNG、JPEG、WebP 和 GIF
会进入 DSH 原生视觉通道；否则插件会上传图片并执行 OCR，还可附加一段文本描述。

不支持的二进制格式仍然可以上传，并可通过工具保存到工作区，但放入提示词的
提取结果只会说明“没有可用的文本提取器”。

## 插件增加了什么

- 全页面拖放、图片粘贴、多文件选择器，以及 DSH `/` 菜单中的
  **上传文件…** 入口。
- 中英文标签、状态文本和上传错误通知。
- 1 MiB 顺序分块上传、汇总进度和“正在提取”状态。
- 与输入框同宽的附件栏，显示由插件上传的文件及大小。
- 文本/代码、PDF、DOCX、XLSX、PPTX、Jupyter Notebook 和栅格图片提取器。
- 根据当前模型能力，在 DSH 原生视觉与插件 OCR/文本提取之间自动路由。
- 对用户隐藏的大段上下文：模型收到完整提取内容，对话界面只显示简短附件头。
- 4 个模型工具：读取 Notebook 单元、对 PDF 单页 OCR、描述图片、保存原文件。
- 按会话隔离的文件库、文件名和路径净化、上传限制、残缺上传清理及持久化提取
  结果查询接口。

## 环境要求与安装

- Node.js 22.13 或更高版本。
- 带 Cordis 宿主和网页客户端插件系统的 DSH。

从 [GitHub Releases](https://github.com/lucadxingg/unified-file-reader/releases)
下载并解压，或克隆本仓库，然后把该目录安装到 DSH profile：

```sh
dsh plugin --profile <profile-name> add /path/to/dsh-file-attach
```

安装后重启 `dsh web` 并刷新浏览器；已运行的 GUI 不会热安装此插件。
`cordis.patch.yml` 会添加一条 `file-attach` 配置，npm 包同时暴露宿主入口
`lib/index.js` 和生成后的浏览器入口 `lib/client.js`。

## 添加文件的方式

| 入口 | 实际行为 |
|---|---|
| 拖放 | 捕获阶段的全页面监听器会接管所有文件拖放。没有活动会话时，它仍会阻止浏览器默认行为，仅在控制台警告，然后丢弃文件，不显示 toast。 |
| 粘贴 | 只有剪贴板中至少含一张受支持的栅格图片时插件才接管粘贴；这次粘贴中的所有文件都会被路由，纯文本也会追加到草稿。只有非图片文件的粘贴交给 DSH 自身处理。 |
| `/` 菜单 | 选择 **上传文件…** 打开没有文件类型过滤器的多文件选择器。 |
| 附件栏 **添加** 按钮 | 打开同一个选择器。附件栏只有在一次插件上传开始后才出现，因此第一个附件请用拖放、粘贴或 `/` 菜单添加。 |
| `/attach <id>` | 复用已知附件引用。同一页面生命周期内可以提交内存中缓存的提取内容；刷新后因文件名和大小元数据未持久化，只会提交降级的 ID 提示。 |

在插件上传路径中，客户端和宿主都会拒绝空文件及超过 `maxFileBytes` 的文件；
原生视觉图片的准入则由 DSH 自身负责。宿主只接受活动会话的插件上传。输入框
忙碌时（阶段既不是 `plain` 也不是 `claimed`），插件会提示稍后再试，而不会
开始上传。

同一批中走插件路径的文件会各自独立开始，客户端不会排队，也不会预先检查
`maxConcurrentUploads`。附件栏把所有进行中文件合并为一个汇总进度条。每个
文件发送最后一个请求时，标签会切换为提取状态，进度暂时使用约 95% 的估算值。
提取完成后，插件最多进行两次带草稿版本保护的尝试，把引用 chip 插到草稿末尾。
如果插入失败，客户端会显示错误，但已完成文件仍保留在文件库和附件栏中。

### 图片路由

只有 PNG、JPEG、WebP 和 GIF 被识别为栅格图片。

1. 客户端向宿主查询输入框当前选择的 provider/model。
2. 宿主解析对应的模型元数据。
3. 只有 `inputModalities` 明确包含 `image` 时才返回 `visual: true`。
4. 视觉模型的图片交给 DSH 原生输入框图片栏。
5. 模型能力未知、查询失败或纯文本模型都会回退到插件上传、OCR 和可选描述。
6. 如果 DSH 原生图片 API 拒绝该批图片，也会回退到插件上传路径。

走原生视觉路径的图片不会进入插件文件库，没有 12 位附件 ID，不会显示在插件
附件栏中，也不能用于 `attach_*` 工具。混合选择时，图片走原生视觉，其他文件
仍由插件上传。

## 提取格式支持

| 输入 | 识别方式 | 发送给模型的内容 |
|---|---|---|
| 文本和源码 | `text/*`，或 `txt`、`md`、`csv`、`json`、`html`、`css`、`js`、`ts`、`py`、`go`、`rs`、`java`、`c/cpp`、`sh`、`yaml`、`toml`、`sql` 等已知扩展名 | UTF-8 文本；无效字节序列会被替换。 |
| PDF | `.pdf` 或 `application/pdf` | 合并后的文本层；没有文本层时返回提示，引导模型调用 `attach_pdf_ocr_page`。 |
| Word | `.docx` 或 DOCX MIME | Mammoth 提取的纯文本；不支持旧版 `.doc`。 |
| Excel | `.xlsx` 或 XLSX MIME | 工作表标题和以制表符分隔的单元格值；不支持旧版 `.xls`。 |
| PowerPoint | `.pptx` 或 PPTX MIME | 从幻灯片 XML 提取的标题和文本；不支持旧版 `.ppt`。 |
| Jupyter Notebook | `.ipynb` | 每个单元的类型和源码；初始提取只保留每个单元非 display 文本输出的最后两行。 |
| 栅格图片 | 按 MIME 或扩展名识别 PNG/JPEG/WebP/GIF | 可探测的格式/尺寸、Tesseract OCR，以及可选的简短 LLM 描述。仅在原生视觉不可用或失败时使用。 |
| 其他二进制 | 以上之外的格式 | 一条包含不支持扩展名和 MIME 的说明；原文件仍可由 `attach_save` 保存。 |

每个提取结果最多 `maxExtractChars` 个字符。发生截断时，文本和持久化元数据都会
标记。提取失败不会丢弃已经上传完成的文件：插件会保留原文件和错误提取结果，
模型仍可调用 `attach_save`。

### 图片 OCR 与自动描述

OCR worker 会复用；`ocrLanguages` 改变时会重建。`explainImages: true` 时，
插件还会尝试使用第一个可用 LLM provider 和 model 生成一次简短描述。自动描述
同时依赖 `llm` 和 `attachments` 服务；服务缺失、模型信息缺失、超时或调用失败
都不会让上传失败，已有 OCR 结果仍会保留。

## 模型和用户分别看到什么

插件上传成功后，实际提交给模型的文本如下：

```text
[attached file "report.pdf" (2.4 MB) id=a1b2c3d4e5f6]
----- extracted content -----
…提取出的文本…
----- end -----
```

浏览器会从渲染出的对话文本中移除提取区块，只显示附件头；底层提交消息仍包含
完整提取内容。提示词中不会出现文件库路径。

12 位小写十六进制 `id` 是所有工具首选的附件标识。文件名也可以使用，但仅当
当前会话文件库中恰好有一个同名上传时有效；存在同名文件时必须使用 ID。

附件元数据只保存在浏览器内存中。页面刷新后，恢复的引用无法取回原文件名和
大小，因此会降级为：

```text
[attached file id=a1b2c3d4e5f6 — extraction unavailable after reload; use attach_* tools with id a1b2c3d4e5f6]
```

原文件和 `extract.json` 仍保存在文件库，工具仍能通过 ID 找到原文件。

## 模型工具

4 个工具都返回文本；业务错误会作为工具错误返回。它们只能操作当前会话中由
本插件上传到文件库的文件。

### `attach_notebook_output`

返回一个完整的 Jupyter 单元：序号/类型、源码、全部文本输出、错误/traceback，
以及被省略的非文本 MIME 数据类型与字节数。

```json
{"id":"a1b2c3d4e5f6","cell":0}
```

- `id`：附件 ID，或唯一的 Notebook 文件名。
- `cell`：从 0 开始的索引；非整数或越界会报错。
- 附件文件名必须以 `.ipynb` 结尾。

### `attach_pdf_ocr_page`

以 2 倍缩放栅格化一个 PDF 页面，再使用 `ocrLanguages` 执行 OCR。

```json
{"id":"a1b2c3d4e5f6","page":1}
```

- `id`：附件 ID，或唯一的 PDF 文件名。
- `page`：从 1 开始的正整数页码。
- 附件文件名必须以 `.pdf` 结尾。
- 没有识别出文本时返回 `(no OCR text on page N)`。

### `attach_describe_image`

使用自定义提示词启动 `describeProvider` 配置的子代理。

```json
{"id":"a1b2c3d4e5f6","prompt":"列出界面中所有可见文字"}
```

- `id`：附件 ID，或唯一文件名。
- `prompt`：必填且不能为空。
- 需要 DSH 子代理服务。附件服务可用时会把原始字节作为图片传给子代理；否则
  子代理只会收到文件名和提示词。
- 实现并不强制检查图片扩展名，但该工具的预期输入是 PNG/JPEG/WebP/GIF。
- 返回子代理文本、`(empty description)`，或子代理未正常完成时的工具错误。

### `attach_save`

把未经修改的原文件从文件库复制到会话工作区。

```json
{"id":"a1b2c3d4e5f6","path":"docs/report.pdf"}
```

- `id`：附件 ID，或唯一原文件名。
- `path`：相对于会话工作区的目标路径。
- 自动创建父目录。
- 解析到工作区根目录本身或工作区之外的路径会被拒绝。
- 已存在的目标文件会被覆盖。
- 返回规范化后的工作区相对路径。

## 宿主 HTTP 接口

这些接口用于配套网页客户端，不是独立的公网远程 API。

| 方法与路径 | 用途 |
|---|---|
| `POST /api/dsh-file-attach/upload` | 新建或继续分块上传；校验活动会话、元数据、限制、分块 header 和最终字节数；完成后提取并持久化。 |
| `POST /api/dsh-file-attach/abort` | 按上传 ID 尽力删除进行中的上传目录。 |
| `GET /api/dsh-file-attach/extract` | 返回活动会话中有效上传 ID 对应的 `extract.json`。 |
| `GET /api/dsh-file-attach/config` | 返回客户端可见限制和支持的栅格 MIME 类型。 |
| `GET /api/dsh-file-attach/vision` | 判断当前/所选会话模型是否明确支持图片输入。 |

上传元数据通过 `x-session-id`、`x-file-name`、`x-file-type`、
`x-file-size`、`x-chunk-index`、`x-chunk-count` 传递；第一块之后还会发送
`x-upload-id`。宿主会串行写入同一上传的分块。单个请求 body 的上限为
`maxFileBytes + 1 MiB`。

配置接口只返回 `maxFileBytes`、`maxFilesPerMessage`、
`maxConcurrentUploads`、`vaultDir`、`maxExtractChars`、`explainImages`、
`ocrLanguages` 和栅格 MIME 列表；不会返回 `explainTimeoutMs`、
`describeProvider` 或固定的客户端分块大小。

## 配置

编辑 `cordis.patch.yml` 中 `file-attach` 行的 `config`：

| 配置项 | 默认值 | 实际作用 |
|---|---:|---|
| `maxFileBytes` | `52428800`（50 MiB） | 单文件限制，客户端和宿主都会检查。 |
| `maxFilesPerMessage` | `20` | 会返回给客户端，但当前客户端**尚未**执行单消息文件数量限制。 |
| `maxConcurrentUploads` | `20` | 宿主中同时打开的上传会话上限；新的首块超过上限时返回 HTTP 429。 |
| `vaultDir` | `file-attach` | `$DSH_HOME`（或 `~/.dsh`）下保存原文件和提取结果的子目录。 |
| `maxExtractChars` | `80000` | 每个初始提取结果的字符上限。 |
| `explainImages` | `true` | 在插件图片路径上启用尽力而为的自动 LLM 描述。 |
| `ocrLanguages` | `eng+chi_sim` | 图片和 PDF 单页 OCR 使用的 Tesseract 语言 ID。 |
| `explainTimeoutMs` | `30000` | 自动图片描述的中止超时。 |
| `describeProvider` | `spawn` | `attach_describe_image` 启动子代理时使用的 provider。 |

上传分块大小固定为 1 MiB，不是可配置项。

## 存储、清理与安全

插件上传存储在：

```text
$DSH_HOME/file-attach/<净化后的会话 ID>/<12 位 ID>/
├── <净化后的原文件名>
└── extract.json
```

未设置 `$DSH_HOME` 时使用 `~/.dsh`；`vaultDir` 会替换其中的
`file-attach`。文件名只保留 basename，移除控制字符和前导点，去除两端空格，
并限制为 200 个字符；会话 ID 也会被压缩成一个安全路径段。

主动中止或失败的残缺上传会尽力删除。无人继续的残缺上传 10 分钟后过期，宿主
每分钟扫描一次。已完成上传不会自动清理：删除输入框引用不会删除原文件，已完成
的附件栏条目本身也没有删除按钮。插件卸载时，浏览器会中止活动上传，宿主会清理
仍打开的上传会话。

这些接口与网页应用同源；上传、提取和视觉查询会检查活动会话，但没有单独的
Bearer 凭据。中止和配置接口不要求会话 header。除非前方有认证反向代理，否则
请只把 DSH 绑定到 `127.0.0.1`。详见 [SECURITY.md](SECURITY.md)。

## 当前限制

- 浏览器附件元数据和附件栏状态不会跨页面刷新持久化。
- 刷新后的 `/attach <id>` 只会生成 ID 提示，不能把完整提取内容重新注入提示词。
- 附件栏中的已完成条目没有删除按钮，也不会与输入框引用的删除保持同步。
- 当前客户端公开了 `maxFilesPerMessage`，但没有实际执行该限制。
- 已完成的文件库文件没有保留期限或自动垃圾回收策略。
- 扫描 PDF 不会在上传时自动 OCR；需要逐页调用 `attach_pdf_ocr_page`。
- 原生视觉图片绕过插件文件库，因此不能用于插件工具。
- 自动图片描述使用第一个可用 provider/model，不一定是当前对话所选模型。
- 全页面拖放监听器会把任何文件拖放交给当前活动会话。
- 没有活动会话时，拖放仍会被接管并丢弃，只写控制台警告；已定义的本地化
  `noSession` toast 当前没有使用。
- 引用 chip 总是追加到草稿末尾，不会插入当前光标位置。
- 旧版 Office 格式（`.doc`、`.xls`、`.ppt`）没有提取器。
- SVG、BMP、TIFF 等非 PNG/JPEG/WebP/GIF 图片不会走 OCR 或原生视觉；它们按
  文本检测规则或不支持的二进制文件处理。
- OCR 依赖可用的 Tesseract 语言数据；自动化测试会替换 OCR 和 PDF 栅格化后端，
  不会测试真实语言包下载。

## 开发

```sh
npm ci
npm test
npm run build:client
git diff --exit-code -- lib/client.js
npm pack --dry-run
```

`src/client-core.js` 和 `src/client-app.js` 是由
`scripts/build-client.mjs` 组装的普通脚本。修改任一源码后，都要提交重新生成的
`lib/client.js`。CI 会在 Node.js 22 和 24 上运行测试，并检查生成文件和发布包。

项目结构：

```text
lib/index.js              宿主路由、限制、生命周期和工具注册
lib/extract.js            文本、Office、Notebook、PDF、图片和 OCR 提取
lib/ingest.js             准入、净化、文件库路径和模型文本
lib/tools.js              attach_* 工具定义
lib/vision.js             当前模型视觉能力解析
lib/client.js             生成后的浏览器 bundle
src/client-core.js        纯浏览器辅助逻辑
src/client-app.js         浏览器插件和界面行为
scripts/build-client.mjs  浏览器 bundle 组装
test/                     node:test 测试
```

## 发布与贡献

项目遵循语义化版本，变更记录见 [CHANGELOG.md](CHANGELOG.md)。推送匹配的 `v*`
tag 后，工作流会运行测试、检查生成客户端、打包 npm tarball，并创建带自动发布
说明的 GitHub Release。

开发规范见 [CONTRIBUTING.md](CONTRIBUTING.md)，私下报告安全问题见
[SECURITY.md](SECURITY.md)，许可条款见 [LICENSE](LICENSE)。
