# dsh-literature-library —— 安装说明（写给未来的自己 / 维护者）

## 这是什么

DSH Web GUI 的一个插件（host + client 两半）：在**左侧栏**加一个「文献库」图标，
点击后把**中央主区**切换成「文献库」面板。

```
┌──────────────┬──────────────────────┬──────────────────────┐
│ 目录树       │  中文译文（可编辑）  │  原文（PDF.js）      │
│ 热物性       │  [预览][源码][编辑]  │                      │
│  ├ 气体黏度  │  [复制][保存]        │  ← PDF.js 画布       │
│  │  · 文献A  │                      │     阅读器           │
│  │  · 文献B  │  ← Markdown + KaTeX  │                      │
│ 传感器       │     公式             │                      │
│ [扫描] 输入框│                      │                      │
└──────────────┴──────────────────────┴──────────────────────┘
   ▲ 可拖动 ▲            ▲ 可拖动 ▲
```

功能一览：

| 功能 | 说明 |
|---|---|
| **拖动调宽** | 两处分隔条都可拖动；宽度存 `localStorage`，双击分隔条复位 |
| **译文在中间** | 中栏是译文、右栏是原文 PDF，方便逐段对照 |
| **译文/原文对齐** | 译文区第 1 行与「原文 PDF」标题栏同高（40px）；第 2 行「预览 / 源码 / 编辑」与 PDF.js 工具条同高（35px，`--ll-pdf-toolbar-h`），两侧正文从同一水平线开始 |
| **PDF 连续滚动** | 鼠标滚轮/触控板在右侧原文栏直接无级上下浏览所有页，不需要点翻页；只渲染视口附近的页，滚远释放 canvas；页码随滚动实时更新，输入页码/翻页按钮会平滑定位。纸面白底、无四周黑框，适应宽度时铺满栏宽 |
| **无级字号调节** | 左栏底部「字号」支持 **1%–1000%**：拖动滑块、输入百分比，或 `Ctrl +` / `Ctrl -` 调整（每次 10 个百分点），`Ctrl 0` 复位。只放大插件文字，PDF 画布缩放仍由 PDF 工具条独立控制；选择保存在 `localStorage` |
| **双通道一键更新** | 工具条「更新」支持 **GitHub 在线更新**（检查最新 release 并下载）和 **本地更新包**（扫描 `<DSH_HOME>/literature-library/updates/*.tgz`，或直接选 tarball 上传）。两条路径都先校验、备份旧文件，失败自动回滚；本地方式完全不需要外网 |
| **可编辑 md 编辑器** | 中栏有三个模式：**预览**（渲染公式）/ **源码**（只读看原始 Markdown）/ **编辑**（可改）。有未保存改动时显示提示点与「保存」按钮；「复制」把全文 Markdown 放进剪贴板 |
| **添加外部文件夹** | 左栏顶部「＋ 导入」打开**文件夹浏览器**：起点是**盘符列表**（Windows），可逐层点进去，也可**直接粘贴路径**跳到任意位置（文件夹分散在各磁盘时最省事）。把该文件夹（含所有子文件夹）里的 PDF **复制**进 `library/papers/<文件夹名>/`，并保留目录层级作为分类 |
| **目录树分类** | 按登记时的**子文件夹层级**展示。`library/papers/热物性/气体黏度/a.pdf` → 树里 `热物性 › 气体黏度 › a` |
| **扫描库内目录** | 输入框填**库内**相对路径（默认 `library/papers`），点「扫描」→ 登记该目录下已有 PDF |
| **一键翻译** | 未翻译的文献旁有「翻译」标签按钮 → **直连 DeepSeek API** 翻译（见下节），条目下方显示真实进度。工具条还有「翻译未译」批量排队 |
| **翻译进度** | 直连任务的进度是**真实的分块进度**：`翻译第 3 / 12 块` + 百分比，完成后显示 token 用量。有任务在跑时每 2.5 秒轮询，全部结束自动停止并刷新界面 |
| **频繁切换不卡死** | 原文改用 **PDF.js canvas** 渲染（不再创建浏览器内置 PDF 阅读器）；切换时 `loadingTask.destroy()` 确定释放 worker/文档。选中项停稳后才加载（译文 120ms、PDF 400ms），并用 Range 只拉当前页附近的数据。预览 HTML 用 8 篇 LRU 缓存 |
| **Markdown 防死循环** | 兼容 `$$` / `\[` 与公式首行写在同一行；段落分支强制前进，遇到不完整表格行等未识别边界也不会原地打转。回归测试覆盖《高压下气体流量标准的比较》的写法 |
| **版本号显示** | 左栏底部常驻版本号与 `PDF.js` 标记；host 的 `GET /version` 从 `package.json` 读取，升级后一眼确认运行版本。变更记录见根目录 `CHANGELOG.md` |
| **插件市场安装** | bundle 包声明 `dsh.bundle.patch` + `cordis.patch.yml`，DSH Plugins 页面可直接选 `.tgz`/本地目录安装；数据默认在 `<DSH_HOME>/literature-library`，不再依赖用户工作区 |
| **搜索筛选** | 左栏顶部搜索框按**标题（中/英）、作者、期刊、DOI、年份、分类**即时过滤；回车选中第一条，Esc 清除。搜索只影响显示，不改文献库 |
| **手动排序 / 置顶** | 条目 hover（或选中）后出现 **📌 / ↑ / ↓ / ⋯**：置顶的文献永远排在该文件夹最前，↑↓ 在文件夹内逐位调整。顺序写入 `library.json` 的 `pinned` / `order` 字段，刷新、重启、换机器都保留。右键菜单里也有同样三项 |
| **上下篇导航** | 阅读区标题栏有 **‹ 3 / 42 ›**：按侧栏当前显示顺序（含搜索/折叠/隐藏过滤）快速切换上一篇、下一篇 |
| **右键菜单** | 在文献上**右键**，或点条目右侧的**「⋯」按钮**：打开 / 翻译 / 重新翻译 / 隐藏 / 取消隐藏 / 打开翻译会话 / 移除。在**分类标题上右键**，或点标题右侧的「⋯」：收起展开 / 隐藏整个文件夹 / 取消隐藏 / 移除整个文件夹 |
| **配置 API** | 工具条的「配置」按钮打开对话框：显示当前 key 来源、模型、端点、各项检测结果，并可粘贴新 key 保存（写进 `~/.dsh/.credentials.yaml`，**写前自动备份**，保存后自动回读验证） |
| **补全期刊信息** | 工具条的「补全期刊信息」按钮：从**科研通（ablesci.com）**逐篇查询影响因子 / JCR 分区 / 中科院分区 / ISSN 等并写入库里。编辑期刊信息的表单里也有「从科研通查询」，可先查询填入表单、确认后再保存 |
| **翻译全部只看可见** | 「翻译未译」**只处理可见且未翻译**的条目——隐藏的一律跳过，并在确认框里说明跳过了几篇 |

> **为什么「⋯」按钮是必须的**：隐藏/删除原先只放在右键菜单里，结果用户根本发现不了
> （原文反馈「点击之后依旧没有删除与隐藏」）。现在右键与可见按钮**两条路都能进菜单**。
| **期刊信息编辑** | 顶部「填写/编辑期刊信息」展开表单：标题、年份、作者、分类、期刊名、缩写、影响因子、JCR 分区、中科院分区、ISSN、出版商、DOI、Top 标记。保存后写回 `library.json` 并刷新界面 |
| **文件夹折叠** | 点击分类标题即可**收起/展开**（标题左侧有 ▸/▾ 指示）。工具条有「全部收起 / 全部展开」。折叠状态存 `localStorage`，刷新后保留 |
| **隐藏文献** | **右键**条目 → 「隐藏」→ 该篇不再显示（但**仍在库中**）。工具条勾选「显示隐藏 (N)」可看到它们（淡色 + `已隐藏` 标签），右键「取消隐藏」恢复 |
| **隐藏文件夹** | **右键**分类标题 → 「隐藏整个文件夹（含子文件夹）」，便于收起不看的主题 |
| **删除文献** | **右键**条目 → 「移除」→ 二次确认后从库中移除。**PDF 不是永久删除**，而是移到 `library/trash/<时间戳>/`，误删可手动找回 |

### 翻译是怎么做的（直连 DeepSeek API）

**不用 agent 会话**。早先的实现是「创建翻译会话 + 投递提示词」，但那套机制不可靠：
实测**13 个会话全部只写入了会话头、提示词从未被接受**（接口返回 200 却什么都不发生），
排查多轮未果。改成直连 API 后路径短、可控、进度可见。

流程：

```
PDF ──tools/extract_pdf.mjs──▶ 文本 ──切块──▶ 逐块调用 DeepSeek ──▶ 合并写入译文
```

| 环节 | 说明 |
|---|---|
| **端点** | DeepSeek 的 Anthropic 兼容 Messages API：`https://api.deepseek.com/anthropic/v1/messages`（与 DSH 自己的 `dsh-llm-deepseek` provider 同一端点） |
| **鉴权** | 头 `x-api-key` + `anthropic-version: 2023-06-01` |
| **API key 来源** | ① 插件配置 `apiKey` ② 环境变量 `DEEPSEEK_API_KEY` ③ `$DSH_HOME/.credentials.yaml` 里的 `DEEPSEEK_API_KEY`（DSH 自己的凭据文件） |
| **模型** | 默认 `deepseek-flash`，可用配置 `model` 改 |
| **推理块** | `deepseek-flash` 会先输出 `thinking` 块——那是推理过程，**必须过滤掉**，否则会污染译文。但要注意它**也消耗 max_tokens**，所以 `maxTokens` 给小了会出现「只有推理、没有正文」，此时会明确报「请调大 maxTokens」 |
| **切块** | 默认每块约 3000 token，在段落/句子边界切；这样进度能显示成「第 3 / 12 块」，也避免超上下文 |
| **产物** | `library/translations/<slug>/<slug>.md`（固定路径，不跟随原 PDF）。抽取文本留在 `library/extracted/<slug>/` 便于追溯 |

**系统提示词**在 `tools/deepseek_translate.mjs` 的 `buildSystemPrompt()` 里，
固化了你的九条硬性要求（术语加 `*`、去双栏、图注、参考文献、断段合并、上下标、
LaTeX 公式、只输出译文等）。

**进度接口**：`POST /translate-job` 启动（立即返回 jobId）→ `GET /translate-job?id=` 查询。
任务状态在 host 内存里；**产物在磁盘上**，所以重启后译文仍在。
重复点同一篇会复用进行中的任务，不重复烧 token。

### 隐藏 vs 删除
| | 隐藏 | 删除 |
|---|---|---|
| 库中的条目 | 保留（`hidden: true`） | 移除 |
| PDF 文件 | 原地不动 | 移到 `library/trash/<时间戳>/` |
| 可逆性 | 一键「显示」即可恢复 | 需手动从 trash 搬回并重新扫描 |
| 用途 | 暂时不想看 | 确定不要了 |

**删除是软删除**（`rename` 到回收站，不是 `unlink`）——文献库是长期积累的数据，
误删的代价远大于多占一点磁盘。`library/trash/` 不会被 `/scan` 收进来
（`/scan` 只扫 `library/papers/`），确认无误后可自行清空。

**隐藏的实现细节**：`index.json` 里带 `hidden` 字段，客户端据此过滤；
被隐藏的文献**仍然计入 `index.json` 的总数**，`counts.byStatus` 也不排除它们——
过滤只发生在界面层，这样服务端统计始终是「库的真实全貌」。

### 手动排序与置顶（`pinned` / `order`）

侧栏每个条目的顺序由 `library.json` 里两个**纯展示字段**决定，不动 PDF、译稿或分类：

| 字段 | 含义 |
|---|---|
| `pinned` | 是否置顶。置顶条目永远排在本文件夹最前 |
| `order` | 同一文件夹内的手动位次（升序，服务端按 0、10、20… 编号） |

排序优先级：**置顶 → `order` → 标题（中文按拼音）**。旧库没有这两个字段时按标题排，
升级后现有顺序不会突变。

- 「↑ / ↓」只在与当前条目**同为置顶或同为普通**的相邻项之间交换，因此不会出现
  「点了上移却被置顶规则挡住」的错觉；
- 上移/下移时客户端把**该文件夹的完整新顺序**发给 `POST /reorder`，host 只负责编号落盘，
  比较器只在客户端维护一份；
- 取消置顶会保留它的 `order`，所以它会回到普通条目的靠前位置，而不是随机位置。

### 「添加文件夹」vs「扫描」的区别（重要）

| | ＋ 导入 | 扫描 |
|---|---|---|
| 源位置 | **任意位置**（工作区外也行，如 `E:\Wego\科研项目`） | **只能在 `library/` 之内** |
| 行为 | **复制** PDF 进 `library/papers/<文件夹名>/`，保留子目录层级 | 就地登记已有 PDF |
| 用途 | 把散落在别处的论文收进库 | 手动往库里放了 PDF 后登记 |
| 代价 | 磁盘上多一份副本 | 无 |

**为什么「扫描」不能扫库外**：`/file` 路由限制在 `library/` 之内（有意为之的安全边界），
库外的 PDF 读不到、也就没法在面板里显示。所以外部文件夹必须先**复制进来**。
这也让文献库保持自包含——备份只需搬 `library/` 一个目录。

### 译稿位置是固定的

译稿一律写入 `library/translations/<slug>/<slug>.md`，**不跟随原 PDF 的路径**。
`library.json` 里为每篇记录了 `translationPath` 字段；`/translate` 投递提示词时会
把该路径明确写进要求里。

## 数据来源

- 面板读 `<数据根>/library/index.json`（由 `tools/library.mjs export` 生成）；
- 文献的 PDF 与译文按同一数据根的相对路径读取；
- **扫描与翻译会写库**（`library/library.json`），不再是纯只读。
- 数据根优先级：`config.workspaceRoot` → `DSH_LITERATURE_WORKSPACE` → 含
  `library/index.json` 的 cwd/上级目录 → 市场安装默认 `<DSH_HOME>/literature-library`。

使用前先导出一次索引：

```powershell
node tools/library.mjs export
```

## 关键实现决定（为什么这样做）

| 决定 | 原因 |
|---|---|
| 用「主区面板 + 侧栏图标」而不是「右侧栏标签页」 | 右侧栏宽度有限，左右对照阅读会非常拥挤；主区宽度充裕。侧栏图标 → 切换主区面板是 DSH 的原生模型（`sidebar.panellist` + `main`） |
| PDF 用 **PDF.js canvas**（本地 pdfjs-dist + Range） | 浏览器内置 PDF 阅读器在连续切换时会反复创建 PDFium 实例，实测切到第三篇左右就会卡死，而且大 PDF 会整份进内存。PDF.js 由我们控制 `loadingTask.destroy()`，只拉当前页附近的字节；工具条也是自己的 35px 行，和译文严格对齐。失败时提供「兼容模式」回退到内置阅读器 |
| 文件与动作都走 **host 侧 HTTP 路由** | 主区面板拿不到 Session，用不了 `workspaceFiles` Remote（要 sessionId 授权）；`dsh-resource://` 又是内部虚拟地址，fetch 取不到 |
| 「一键翻译」在 **host 侧创建会话** | 客户端 `remote.session.prompt` 需要 sessionId，主区面板没有；而 host 侧可 `ctx.get('agents').create({sessionId, meta:{cwd}})` + `agent.followup(createUserMessage(...))`，不依赖任何会话上下文 |
| 从 **DSH 内核**动态解析 `dsh-llm`/`dsh-session` | 插件在工作区，工作区没装 `@deepseek-ai/*`；但插件是被 npx 缓存里的内核加载的，`createRequire(import.meta.url)` 能沿那棵树找到。已实测通过 |
| **不** require 任何 Harness Client 包 | 官方 `cordis-plugin-development/references/practices.md` 明确禁止第三方插件加载 Harness Client 包（它们会随时变、纯 JS 无类型检查、组件抛错会让整个 slot 空白）。因此图标是内联 SVG，Markdown 渲染是自己写的极简实现 |
| 拖动用 pointer events + `setPointerCapture` | 指针拖到面板外也不丢事件；宽度用百分比而非像素，窗口缩放后仍合理 |
| KaTeX 从 CDN 按需加载 | 避免把 KaTeX 打进插件包。加载失败时降级为代码显示，面板不会崩 |
| 只用 `--dsw-alias-*` 主题变量 | 跟随用户主题（明/暗），不改主题系统 |

## HTTP 接口（host 半提供）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/literature-library/index` | 读 `library/index.json` |
| GET | `/literature-library/version` | 插件版本（从 `package.json` 读取）；界面左栏底部显示 `vX.Y.Z` |
| GET | `/literature-library/file?path=<相对路径>` | 读库内任意文件（PDF/译文/抽取文本）；只允许 `<工作区>/library` 之下。支持 `Range`（206）与流式返回，PDF.js/内置阅读器都按需拉取 |
| GET | `/literature-library/pdfjs/<path>` | PDF.js 运行时（`build/pdf.min.mjs`、worker、cmaps、standard_fonts、wasm、iccs）；**白名单**路径，不允许目录穿越 |
| POST | `/literature-library/scan` | body `{ dir }`；登记**库内**目录的 PDF，按子文件夹分类 |
| GET | `/literature-library/browse?path=<绝对路径>` | 列出该目录的**子文件夹**（形状同 DSH 的 `DirectoryListing`）。省略 `path` 时：Windows 给**盘符列表**，其他平台给主目录 |
| POST | `/literature-library/add-folder` | body `{ dir, group?, dryRun? }`；把**库外**文件夹的 PDF 复制进库（保留子目录），返回 `{ copied, added, skipped, dest }` |
| POST | `/literature-library/translate` | body `{ slug }`；创建翻译会话并投递提示词，返回 `{ sessionId, url, outputPath }` |
| POST | `/literature-library/save` | body `{ slug, content, baseContent? }`；保存译文 |
| POST | `/literature-library/update` | body `{ slug, paper?, journal? }`；更新元数据/期刊信息 |
| POST | `/literature-library/mutate` | body `{ action: 'hide'\|'unhide'\|'delete', slug? , folder? }`；隐藏/恢复/删除（`folder` 会覆盖其子路径） |
| POST | `/literature-library/reorder` | body `{ action: 'order', folder, slugs }` 整组重排，或 `{ action: 'pin'\|'unpin', slug }` 置顶/取消置顶；只写 `library.json` 的展示字段，不动文件 |
| GET | `/literature-library/config` | 读 API 配置与 key 来源（**不回传完整 key**，只有前缀） |
| POST | `/literature-library/config` | body `{ apiKey }`；写入 `~/.dsh/.credentials.yaml`（先备份），并回读验证 |
| GET | `/literature-library/translate-config` | 直连翻译是否就绪（模型/端点/密钥来源） |
| POST | `/literature-library/translate-job` | body `{ slug, model?, maxTokens? }`；**立即返回 jobId**，翻译在后台跑 |
| GET | `/literature-library/translate-job?id=` | 查任务进度；不带 `id` 返回全部任务 |
| GET | `/literature-library/sessions` | 本插件创建的翻译会话及其阶段（读会话日志） |
| GET | `/literature-library/progress?sessionId=` | 单个会话的进度（面板轮询用） |
| GET | `/literature-library/vendor?name=katex.min.js` | 插件自带的 KaTeX 本地副本（**白名单**只允许 `katex.min.js` / `katex.min.css`），CDN 不可达时兜底 |
| POST | `/literature-library/fill-journal` | body `{ slug, name?, issn?, dryRun? }`；从科研通查期刊信息并写入（`dryRun` 只查不写） |

### 期刊信息自动补全（科研通 / ablesci）

实现见 `tools/ablesci.mjs`。**实测确认**（不是推测）：

| 环节 | 事实 |
|---|---|
| 搜索 | `GET /journal/index?keywords=<刊名或ISSN>`。参数名就是 **`keywords`**——试过 `keyword`/`wd`/`q`/`name` **全部无效**（会静默退化成默认列表，很容易误判成「站点没数据」） |
| 详情 | `GET /journal/detail?id=<短id>`，**数据是服务端渲染的**（无 AJAX），全部信息都在 HTML 表格里 |
| 能拿到的字段 | 期刊全称/缩写、ISSN(print/online)、最新影响因子 + 历年、WOS 收录库(SCIE) + JCR 分区 + 分区学科、中科院分区 + 大类 + TOP/综述标记、自引率、h-index、涉及领域、出版商、出版国家/语言/周期、创刊年份、年发文量、Gold OA 占比、预警名单、编辑部地址 |

**两个踩过的坑（都写进代码注释了）**：

1. **不能把页面所有 `<td>` 拉平成一个数组再取「下一格」。**
   表格里标签与值**常在同一 `<tr>` 的不同列**，拉平后「下一格」往往是**下一行的标签**，
   于是字段整体错位（实测：影响因子取空、JCR 分区取成了排名 `34/81`）。
   正确做法是**按 `<tr>` 逐行解析**，同行取右邻格；标签单独占行时才看下一行。

2. **中科院分区是嵌套表格**，且正则里 `<td[^>]*>\s*中科院` 的 `\s*` 会**导致匹配失败**
   （实际 HTML 里 `<td>` 后**紧跟**标签文字）。改用
   「`中科院\d{4}年分区` 之后不远处的第一个 `<table>`」这种宽松定位更稳。

**示例结果**（Metrologia）：影响因子 3.2、JCR Q2 (SCIE)、中科院 3区 工程技术(2025)、
ISSN 0026-1394、非 TOP、非综述。

**匹配与安全**：
- ablesci 的搜索是模糊的，直接取第一条**经常抓错刊**（实测搜 Metrologia 时后面跟着
  Scientific Reports、BMC Cancer…）。所以代码会先按**归一化刊名精确匹配**、
  再「互相包含」，给了 ISSN 时还会用详情页的 ISSN **二次校验**。
- 刊名没精确匹配上时，结果里会带 `matchedExactly: false`，界面**明确提示核对**，
  不静默写入可疑数据。
- 只覆盖**非空**的抓取值，不会把用户手工填的字段清掉。
- 批量查询**逐篇 + 1.2 秒间隔**——每次要发 2 个 HTTP 请求，批量并发会给站点压力。

> 数据来源会写进 `journal.ablesci.sourceUrl` 与 `fetchedAt`。影响因子/分区逐年变化，
> 且属于第三方整理的数据，**请以学校和期刊官方口径为准**。

### 公式渲染：一个真实踩过的坑

**症状**：面板里出现红色的「公式渲染错误」。

**根因有两个，都在客户端渲染器上**：

1. **`throwOnError: false`**。我原先这么写，以为「失败就降级」。
   实际上 KaTeX 在 `false` 时会**把错误信息画进页面**（红色文字），
   而我们的 `try/catch` **永远不会触发**——用户看到的就是那句错误。
   改成 `throwOnError: true`，才能接住错误走自己的降级路径。

2. **`\tag` 只能用在独立公式里**。实测译稿里公式常写成
   `$Q_0 = \dots \tag{1}$`（单个 `$` 包裹但带编号），
   KaTeX 抛 `\tag works only in display equations`，整条公式失败。

**修法**：`renderTex()` 统一处理——检测到 `\tag`（或 `\begin{align}` 等）就
**自动按独立公式渲染**，公式与编号都能正常显示；
先按行内试一次，失败再按独立公式试一次；都失败才降级为源码 + 错因（挂在 `title` 上）。

**校验方式**：`tools/test_katex_formulas.mjs` 用**真实的 KaTeX** 逐条检验译稿里的公式
（复刻客户端的渲染决策，包括 `\tag` 自动提升）。

```powershell
node tools/fetch_katex.mjs          # 先把 KaTeX 拉到本地（离线校验用）
node tools/test_katex_formulas.mjs --all
```

**实测结果：775 条公式全部可渲染，0 失败**（此前 42 条因 `\tag` 失败）。

> 一个易错点：`katex.min.js` 是 UMD 包，直接在 Node 里 `import` 会报
> `Cannot set properties of undefined (setting 'katex')`。
> 它的分支顺序是 `module.exports` → `define.amd` → `exports.katex` → `self.katex`，
> 所以要在 `vm` 沙箱里同时提供 `module` 与 `exports`（且 `exports` 指向 `module.exports`）。

**KaTeX 的两级加载**：先 CDN，失败则用插件自带的本地副本
（`plugin/literature-library/vendor/`，走 `/vendor` 路由）。
本机若访问不了 jsdelivr，公式仍能正常渲染。

### 翻译进度是怎么判断的

host 直接读 DSH 的会话日志
（`$DSH_HOME/sessions/<工作区编码>/<会话 id>/session.v4.jsonl.zstd`，
zstd 压缩的 JSONL，Node 24 自带 `zstdDecompressSync`），统计事件数与阶段：

| 阶段 | 判据 | 含义 |
|---|---|---|
| `queued` | 只有 1 个 `session` 头事件 | **提示词从未被接受**——agent 没跑起来（这正是「点了翻译没反应」的特征） |
| `running` | 事件 ≥ 2 且出现 `streaming`/`step` 阶段 | 正在翻译 |
| `done` | 同时出现 assistant 事件与 `idle` 阶段 | 本轮完成 |
| `failed` | 事件少且含 error/failed | 出错 |
| `missing` | 找不到会话文件 | 日志被清掉了 |

**为什么读文件而不是在内存里记状态**：重启后仍在；而且它能回答最关键的问题——
「提示词到底有没有进去」。之前排查「接口返回 200 却什么都不发生」时，
正是靠这个才发现所有会话都停留在 `queued`。

**只认 `sess-` 前缀**：插件创建的翻译会话都用这个前缀，因此不会把用户的正常对话
当成翻译任务列出来，`/progress` 也拒绝非该前缀的 id（避免拿它探测别人的会话）。

**写接口的安全约束**（因为 DSH 的 web 服务器**自身不带 TLS/鉴权**，这些路由对本机任何进程开放）：

- 读：限制在 `<工作区>/library` 之下，并对解析后的绝对路径做前缀校验阻断 `..`；
- `/scan`：同样限制在 `library/` 之下；
- `/browse`：**能列出任意目录的子文件夹名**（不含文件内容）——这是「添加文件夹」
  要跨磁盘工作的前提。可用 `config.allowFileSystemBrowse: false` 关闭。
  由于 DSH 的 web 服务器不带鉴权，**只在自己机器上用**；多人共用请关掉；
- `/add-folder`：**会读取工作区外的任意目录**（这是该功能的用途），但
  **只把 `.pdf` 复制到 `library/papers/<sanitize 过的组名>/` 之下**，组名经过
  `slugify` 且目标路径再做前缀校验，避免 `..` 逃逸；`dryRun: true` 可先预览不落盘；
- `/save`：**只允许写 `<库>/translations/` 之下的 `.md`**，其他一律 403；
  并且请求里带 `baseContent`（界面加载时的原文）时，会先比对磁盘——
  不一致就返回 **409 而不是覆盖**，避免把别处的改动静默冲掉；
- `/update`：只接受**白名单字段**（`title/year/authors/category/note` 与
  `journal.{name,abbr,doi,impactFactor,jcrQuartile,casQuartile,isTop,issn,publisher}`），
  其余字段忽略；`impactFactor` 强制转数字、`isTop` 强制转布尔；
- `/mutate`：只接受三种 action；`delete` 是**软删除**（`rename` 到 `<库>/trash/`，
  目标路径再做前缀校验），不做 `unlink`。


## 安装步骤

### 0. 先做静态校验

```powershell
node tools/check_plugin.mjs plugin/literature-library/client.js
```

应当输出 `✓ 静态校验通过`。这一步在把插件装进**运行中的** DSH 之前抓语法/接口错误，
避免把 GUI 弄坏。

### 方式 A（推荐）：DSH 插件市场 / bundle 包

不再需要手工改 profile。构建并安装：

```powershell
node tools/build_market_bundle.mjs
```

产物：

```text
dist/market/dsh-literature-library/            # 可直接选的本地目录
dist/market/dsh-literature-library-0.4.3.tgz   # tarball
dist/market/index.json                         # 市场索引（npm 源，发布后使用）
```

在 DSH Web 左侧 **Plugins → Add plugin → Install a third-party plugin** 中填
`.tgz` 绝对路径（或解压目录绝对路径）；等价 CLI：

```powershell
dsh plugin add "E:/path/to/dsh-literature-library-0.4.3.tgz"
```

市场包只带程序，首次启动会在 `<DSH_HOME>/literature-library/library/` 建空库；
已有工作区文献库可用 profile 覆盖：

```yaml
- id: literature-library
  config:
    workspaceRoot: 'E:/path/to/existing/library-workspace'
```

> **从路径行迁移时**：先删掉 `cordis.patch.yml` 里原来的
> `id: literature-library` 路径行，再安装市场 bundle；否则同一个 id 会出现两个
> 宿主行/两个文献库面板。现有数据不会自动搬走：要么在上面覆盖 `workspaceRoot`，
> 要么把旧的 `library/` 复制到 `<DSH_HOME>/literature-library/library/`。

> **前置条件**：DSH 的 Plugins/市场安装走 pnpm。本机当前没有全局 `pnpm`，
> 需要先安装（例如 `npm install -g pnpm` 或 `corepack enable pnpm`），
> 否则 Plugins 页面会报找不到包管理器。没有 pnpm 时仍可使用下面的便携包/路径行。

### 方式 B：给 web profile 加一条「路径行」（开发 / 无 pnpm 时）

本机**没有 pnpm**，所以 `dsh plugin add` 不可用。改用路径行直接加载：

编辑 `C:\Users\Administrator\.dsh\profiles\web\cordis.patch.yml`，在**文件末尾追加**：

```yaml
- insert:
    - id: literature-library
      name: 'E:/Wego/我的日常/自建项目/文献翻译插件/plugin/literature-library/index.js'
      config:
        workspaceRoot: 'E:/Wego/我的日常/自建项目/文献翻译插件'
```

> **建议写上 `config.workspaceRoot`**（不写也有自动探测兜底，但显式更确定）。
> 不写时 host 半会先用 `process.cwd()` 试探，而那是**启动 `dsh web` 时所在的目录**；
> 若从用户主目录启动（例如直接敲 `npx @deepseek-ai/dsh web`），这个候选会落空，
> 再靠后续的自动探测兜底。

`config` 还支持（都可选）：

| 键 | 默认 | 说明 |
|---|---|---|
| `workspaceRoot` | 自动探测 | 工作区根目录 |
| `libraryDir` | `library` | 文献库子目录 |
| `papersDir` | `papers` | PDF 存放目录（相对 `libraryDir`） |
| `routePrefix` | `/literature-library` | HTTP 路由前缀 |
| `agentPreset` | 无 | 创建翻译会话时使用的 agent preset |
| `allowFileSystemBrowse` | `true` | 是否允许 `/browse` 列目录（关掉则「添加文件夹」不可用） |
| `dshModulesRoot` | 自动探测 | DSH 的 `node_modules` 目录；仅当自动定位内核失败时才需要 |

**已实测验证**（用复制出来的 profile 跑 `--dump-config`）：该行会被正确解析为

```
name: >-
  file:///E:/Wego/.../plugin/literature-library/index.js
```

一条行就够，原因：
- `index.js` 是 **host 半**，注册只读 HTTP 路由（`inject = ['webServer']`）；
- **客户端半会被自动发现**：DSH 的 client-modules 从该入口向上找到同目录的 `package.json`，
  读到 `dsh.client.platform === 'web'` 与 `exports["./client"]`，再把 `client.js`
  作为浏览器 bundle 提供。
  **注意：`dsh.client` 字段是必需的**——缺了它客户端半边会被**静默忽略**
  （host 半照常加载、日志里没有任何提示、侧栏就是不出图标）。这是本次踩过的坑。

要点：
- 路径用**正斜杠**（Windows 反斜杠也可以，但正斜杠更稳）；必须是绝对路径；
- 指向 **`index.js`**，不要写成包名 `dsh-literature-library`
  （那要求包装在 profile 的 node_modules 里，而本机没有 pnpm）；
- 目录路径（写到 `.../literature-library` 不带文件名）也能被解析成 URL，
  但**不推荐**——能否自动补 `index.js` 取决于 Node 的目录导入行为。

**若客户端界面没有出现**（host 路由可用但侧栏没有图标），说明客户端 bundle 的发现没走通，
这时把上面那条行换成**两条行**，显式声明客户端入口：

```yaml
- insert:
    - id: literature-library
      name: 'E:/Wego/我的日常/自建项目/文献翻译插件/plugin/literature-library/index.js'
    - id: literature-library-client
      name: 'E:/Wego/我的日常/自建项目/文献翻译插件/plugin/literature-library/client.js'
```

### 3. 重启 DSH

**最简单**：双击工作区根目录的 `重启DSH.cmd`。它会先停掉占用 3080 的进程，
再 `cd` 到工作区启动 `npx @deepseek-ai/dsh web`（cd 是为了让会话仍归到本工作区）。

手动的话：

```powershell
taskkill /PID <监听3080的PID> /F
cd "E:\Wego\我的日常\自建项目\文献翻译插件"
npx @deepseek-ai/dsh web
```

**重启会中断当前所有会话。** 配置文件的改动本身是热加载的，但**新插件模块
（host 半与 client 半）只在进程启动时加载一次**，必须重启才能生效。

> **为什么「刷新页面」不够**：客户端 bundle 是每次刷新动态下载的，所以**界面**看起来
> 已经是新版；但 host 半是 JS 模块，只有重启才换。于是会出现
> 「界面新、接口旧」——典型症状就是点「扫描」报 `HTTP 405`。
> 判别方法见下面「排错」。见 `交付说明.md` 里关于 `.cmd` 编码的踩坑记录。

### 4. 验证

刷新 http://127.0.0.1:3080 ，左侧栏应出现一个「文献库」书本图标。
点击它，主区切换到文献库面板；若有报错，按 F12 打开控制台看信息。

## 换工作区 / 换索引路径

见上面第 2 步的配置表。要改就在 profile 的那条行上加 `config:`：

```yaml
- insert:
    - id: literature-library
      name: 'E:/.../plugin/literature-library/index.js'
      config:
        workspaceRoot: 'E:/另一个工作区'
```

客户端不需要改：它只请求 `routePrefix` 下的固定路径，读哪个文件由 host 决定。

## 验证命令（改完插件后先跑这些）

```powershell
node tools/check_version.mjs       # 版本一致性：package.json/CHANGELOG/便携说明/PDFJS_REV
node tools/test_routes.mjs         # host：索引/版本/文件/Range/PDF.js 资源/越权防护，34 项
node tools/test_detect_root.mjs    # host：从各种启动目录自动探测工作区，4 项
node tools/test_actions.mjs        # host：扫描/浏览/加文件夹/翻译/保存/期刊信息/隐藏删除/排序置顶，149 项
node tools/test_progress.mjs       # host：翻译会话与进度判定（用临时 DSH_HOME 造样本），18 项
node tools/test_markdown_math.mjs  # 客户端：公式分隔符 + 行首 $$/\[ + 不完整表格行（防死循环）
node tools/check_plugin.mjs plugin/literature-library/client.js   # 客户端：语法/契约/可渲染
node tools/build_market_bundle.mjs # 市场 bundle + tarball + index.json
node tools/test_market_bundle.mjs  # 独立 DSH_HOME 模拟市场安装，13 项

# 排查「点了翻译没反应」：解压看会话日志里到底记了什么
node tools/read_session.mjs --list
node tools/read_session.mjs <sessionId> --full

# 面板报错时，先判断运行中的实例是「新版 host 半」还是「旧版」（需不需要重启）
node tools/probe_live_routes.mjs 3080

# 改过重启脚本后，用它重新生成 .cmd（别手改 .cmd，见下）
node tools/make_restart_script.mjs
```

全部通过再重启 DSH，能避免把 GUI 弄坏。注意 `test_actions.mjs` 会临时往
`library.json` 里加测试条目并在结束时清理，**跑完请确认 `library/index.json` 只剩真实文献**。

### ⚠️ 改完插件为什么「刷新页面没用」——必须重启 DSH

**实测结论（值得记住）**：DSH 的 client-modules **在首次请求时就把客户端 bundle 缓存住了**。
之后只改磁盘上的 `client.js`，**再请求拿到的还是旧内容**——实测两次请求长度完全相同、
新加的标记没有出现。

所以：

| 改了什么 | 生效方式 |
|---|---|
| `client.js`（客户端界面） | **重启 DSH**（只刷新页面无效） |
| `index.js`（host 路由） | **重启 DSH** |
| `tools/*.mjs`（被 host 动态 import 的） | 不用重启——host 用 `?t=时间戳` 绕过了模块缓存 |
| profile 里的 `config:` | 热加载，不用重启 |

**这正是「隐藏/删除点了没反应」的真正原因**：后端 `/mutate` 是好的（实测 hide 后
`hidden` 从 `false` 变 `true`），但浏览器里跑的仍是**加入右键菜单之前**的旧客户端。
判定方法：`node tools/probe_live_routes.mjs 3080`，看新端点是否「未注册」。

### 排错：面板报 `HTTP 405`

**症状**：点「扫描」提示 `扫描失败：HTTP 405`。

**原因**：**运行中的实例还是旧版 host 半**（没有 `/scan` 路由）。
客户端 bundle 是每次刷新页面动态下载的，所以界面看起来是新的；但 host 半是
JS 模块，**只在启动时加载一次**——所以会出现「界面是新的、接口是旧的」。

**判别方法**：`node tools/probe_live_routes.mjs 3080`
- 若 `/scan` 与 `/nonexistent` 返回**完全相同**的响应 → 旧版，**重启 DSH**；
- 若 `/scan` 返回自己的业务错误（如缺 `dir` 的 400）→ 新版，属于参数问题。

**注意**：`405` 在这个部署里**不代表「方法不对」**——DSH 对未注册的路由也用 405 兜底，
所以要靠响应体区分。

### 排错：文件夹浏览器报「本部署没有 directoryPicker 服务」

**原因**：客户端原先用 `remote.directoryPicker.list()` 列目录，那是 DSH 的 **Remote**
服务，只在右侧栏的 **session 作用域**下注入；本插件挂在 `main`（**根作用域**）上，
拿不到它。

**已修**：改成走本插件 host 半自己的 `GET /browse`（`listDirectory()` 直接用
`node:fs` 实现）。好处是不依赖 DSH 内部服务、还能顺带给出**盘符列表**。

### 排错：双击 `重启DSH.cmd` 后网页没开

**原因**：原先依赖 `dsh web` 自己去开浏览器；当浏览器没有默认配置文件关联时，
它的启动会失败（本机实测过 `spawn EPERM`），窗口看起来就像「卡住没反应」。

**已修**：脚本在启动 dsh **之前**用 `start "" "http://127.0.0.1:3080/"` 自己打开页面。
另有一条更容易排查的经验：**别在同一个 cmd 窗口里先跑 dsh 再跑这个脚本**——
`taskkill` 杀掉 dsh 后，`call npx` 的交互可能被已失效的控制台输入搞乱。
让脚本自己开一个新窗口（双击即可）最稳。

### 排错：`重启DSH.cmd` 刷出一堆「不是内部或外部命令」

**症状**：双击脚本后出现 `'彛閲婃斁' 不是内部或外部命令` 之类的乱码报错。

**根因**：本机 OEM 代码页是 **936 (GBK)**，cmd.exe 用 GBK 解码 `.cmd` 文件。
如果脚本按 **UTF-8 无 BOM** 存盘，里面的中文会变成乱码并被当命令执行。

**实测结论**（本机 GBK 环境下）：

| 写法 | 结果 |
|---|---|
| GBK(936) | ✗ 中文路径解析不正确 |
| **UTF-8 带 BOM** | **✓ 可用** |
| UTF-8 无 BOM + `chcp 65001` | ✗ 报错 |

**因此该脚本的维护规则**（改它之前务必读）：

1. **必须存成 UTF-8 带 BOM**。本项目的编辑工具写出的是**无 BOM**，
   所以这个脚本是用 PowerShell 的 `New-Object System.Text.UTF8Encoding($true)` 生成的。
2. **不要加 `chcp 65001`**：加了反而让 cmd 错误解析 CJK 的 `set` 行。
3. **不要把中文放进 `echo`**：输出写到 936 控制台会乱码，所以脚本的提示信息全用英文。
   唯一的中文只在 `set "WORKSPACE=..."` 那一行。
4. 文件名含中文没问题（双击可用），但在终端里 `cmd /c "…中文路径…\重启DSH.cmd"`
   会因命令行编码失败——要那样跑，先把脚本复制到纯 ASCII 路径。

## 已知限制

1. **期刊信息需要手工录入**：影响因子、分区这类数据没有随论文 PDF 一起发布，
   面板无法自动提取。**面板里可以直接编辑**（顶部「填写期刊信息」按钮）。
2. **KaTeX 依赖外网 CDN**：本机若无法访问 jsdelivr，公式会以代码形式显示（不会崩）。
   要彻底离线，就把 `katex.min.js` 与字体放进工作区，改 `loadKatex()` 的地址。
3. **「复制」依赖剪贴板权限**：浏览器若拒绝 `navigator.clipboard`，会提示并自动
   切到源码模式让你手动全选复制。
4. **一键翻译是「投递后异步进行」**：面板把提示词投给一个新会话就返回，
   翻译过程在那个会话里跑。面板不会自动感知完成——需要手动刷新
   （扫描/翻译成功后会刷新一次；翻译完成后要再刷一次才会出现「已翻译」标记）。
5. **Markdown 渲染是极简实现**：支持标题、粗斜体、行内代码、代码块、表格、引用、
   有序/无序列表、`$...$` 与 `$$...$$` 公式；不支持 HTML、脚注、图片。
6. **`/scan`、`/translate`、`/save`、`/update` 无鉴权**：DSH 的 web 服务器本身不带鉴权。
   已按上面的约束把可写范围收窄到 `translations/` 下的 `.md` 与白名单字段。
7. **编辑器是纯 textarea**：没有语法高亮、没有撤销栈以外的功能、不会自动保存。
   换文献时**未保存的改动会丢**（会重置），所以改完记得点「保存」。
8. **PDF.js 阅读器不支持文本选中/搜索/打印**：它用 canvas 画图，换来的是切换稳定与大文件按需加载。
   需要这些功能时点右上角「新窗口打开」，用浏览器内置阅读器打开。
   PDF.js 加载失败（例如部署的 CSP 禁止 worker）时，面板会给出「兼容模式」按钮回退到内置阅读器。
