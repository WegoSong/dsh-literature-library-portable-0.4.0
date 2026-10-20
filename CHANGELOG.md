# 变更记录（CHANGELOG）

本文件简要记录**每一次功能 / 行为变更**。维护规则：

1. 先在 `plugin/literature-library/package.json` 提升版本号；
2. 在本文件顶部加对应版本的 `## x.y.z — YYYY-MM-DD` 小节；
3. 同步 `packaging/portable/README-安装说明.md` 的当前版本；
4. 运行 `node tools/build_portable_package.mjs`（它会检查本文件是否有当前版本小节，
   没有就拒绝打包）；
5. 发布后重新生成 `dist/dsh-literature-library-portable-<version>.zip`。

版本号由 host 的 `GET /literature-library/version` 从 `package.json` 读取，
界面左栏底部的 `vX.Y.Z` 显示的就是它。

---

## 0.4.4 — 2026-10-20

### 新增

- **按分类扫描原始来源**：在左侧目录树点击一个分类（如「参考文献」），再点扫描行的
  「扫描新增」，host 会扫描该分类**导入时记录的原始外部文件夹**，把新增 PDF 复制回对应分类。
- 支持嵌套分类：选中 `参考文献/子类` 时扫描「原始来源根目录/子类」，并保留子目录层级。
- `＋ 导入` 现在把「顶层分类 → 原始文件夹」记录到 `library.json` 的 `folderSources`；
  旧库没有该字段时，自动从已有文献的 `importedFrom` 推断。
- 扫描行在选中分类时显示分类名；点 `×` 取消选中，回到原来的“手动扫描库内路径”模式。
- 新增 `POST /scan-source`；只复制目标分类下不存在的文件，已存在的按 slug 跳过。

## 0.4.3 — 2026-10-20

### 新增

- **更新支持两种来源**：
  - **GitHub 在线更新**：更新对话框里点「检查 GitHub 更新」，host 读取最新 release，
    下载对应 `.tgz` 后复用同一套校验/备份/回滚逻辑；
  - **本地上传包**：原有 `updates/*.tgz` 扫描和浏览器选择文件上传继续保留。
  - 离线或 GitHub 不可达时只影响在线按钮，本地包仍可正常更新。
- **字号改为无级调节**：
  - 滑块拖动，范围 **1%–1000%**；
  - 数字输入框可直接输入 1–1000；
  - `Ctrl +` 放大、`Ctrl -` 缩小（每次 10 个百分点），`Ctrl 0` 复位到 100%；
  - 仍只缩放插件文字，不改变 PDF 画布；选择持久化到 `localStorage`。

### 说明

- 0.4.1 及更早版本没有「更新」入口，需要手动安装一次 0.4.2 或 0.4.3；
  之后即可离线更新。
- GitHub 在线更新需要 host 进程能访问 github.com；浏览器能打开不等于 host 能访问。

## 0.4.2 — 2026-10-20

### 新增

- **离线一键更新**：工具条新增「更新」，自动扫描
  `<DSH_HOME>/literature-library/updates/*.tgz`，显示本地更新包版本，点「一键更新」即可。
- 也可以在更新对话框里直接选择一个本地 `.tgz` 上传并更新；全程不访问 GitHub、npm 或外网。
- host 新增 `GET /plugin-update`、`POST /plugin-update/apply`：
  - 校验包名、SemVer、`dsh.bundle.patch` 与必要文件；
  - 先把旧文件备份到 `updates/backup-<旧版本>-<时间>/`，失败自动回滚；
  - 用“临时文件 + rename”替换，避免破坏 pnpm store 的硬链接；
  - 更新只覆盖程序文件，不碰 `library/` 和 `node_modules`。
- 更新完成后必须**完全退出并重启 DSH**；运行中的 host 仍是旧代码。

### 说明

- 0.4.1 及更早版本没有「更新」入口，需要手动安装一次 0.4.2；之后即可离线一键更新。
- 更新包格式为 `npm pack` 生成的 `.tgz`（release 里的 `dsh-literature-library-<版本>.tgz`）。

## 0.4.1 — 2026-10-20

### 新增

- 左栏底部新增「字号」下拉框，可选 **100% / 110% / 120% / 130% / 150%**。
- 只放大插件文字，不改变 PDF 画布的缩放；字号选择写入 `localStorage`，刷新后保留。
- 实现方式：根节点写入 `--ll-font-scale`，所有 `font-size` 和固定 `line-height`
  用 `calc(... * var(--ll-font-scale, 1))`；Markdown 正文、编辑框、侧栏、工具条同步放大。

## 0.4.0 — 2026-10-19

### 新增

- **DSH 插件市场可安装的 bundle 包**：
  - `package.json` 声明 `dsh.bundle.patch`，`cordis.patch.yml` 插入 `dsh-literature-library` 宿主行；
  - Web 客户端通过 `dsh.client` 自动发现，不再需要手工写 profile 路径；
  - 包内自带 `tools/`，`pdfjs-dist` 作为 npm 依赖；host 优先从包内解析，旧的
    “工作区路径行 / 便携包”布局仍兼容；
  - 市场包不含用户 PDF/译文；首次启动自动在
    `<DSH_HOME>/literature-library/library/` 建空库。
- 新增 `tools/build_market_bundle.mjs`：生成 bundle 目录、`.tgz` 和 `dist/market/index.json`；
- 新增 `tools/test_market_bundle.mjs`：在独立 `DSH_HOME` 中验证“无工作区”安装、
  空库初始化、`/version`、`/index`、`/pdfjs`。

### 变更

- 原有便携包（install.mjs + zip）保留，作为旧安装方式的兼容；市场安装优先使用 bundle。

## 0.3.4 — 2026-10-19

### 界面

- 取消 PDF 页四周的深色边框：`.ll-pdf-body` 改为纸面白底、去掉左右/上下 padding，
  页面 100% 时直接铺满栏宽；同时去掉页面的深色投影。
- 连续滚动时页面之间只留 12px 白色间隔，视觉上是一整张文档而不是「黑框里的单页」。

## 0.3.3 — 2026-10-19

### 新增

- PDF 原文改为**连续滚动**：所有页按比例占位，鼠标滚轮/触控板直接上下浏览，
  不再需要点「上一页/下一页」。
- 只渲染视口附近（提前约 1.5 屏）的页面；滚远的页释放 canvas，兼顾流畅与内存。
- 工具条页码随滚动实时更新；输入页码或点翻页按钮会平滑滚到对应页。
- 缩放后停留在当前页；`overscroll-behavior: contain` 防止滚到 DSH 外层页面。

### 性能

- `PdfPage` 用 `React.memo`，页码变化不会让 200 多页全部重渲染；
- 页面 canvas 在离开视口后清空，避免长文档滚动到底后内存持续增长。

## 0.3.2 — 2026-10-19

### 新增

- 左栏底部常驻显示插件版本号（`v0.3.2`）与 `PDF.js` 标记；数据来自 host 的新端点
  `GET /version`，host 从 `package.json` 读取，界面不再硬编码版本。
- 新增本 `CHANGELOG.md`，并把它打进便携包；构建脚本会校验当前版本是否有对应小节。
- `test_routes.mjs` 增加 `/version` 契约测试（版本号必须与 `package.json` 一致）。

### 维护

- 便携安装包版本同步为 0.3.2。

## 0.3.1 — 2026-10-19

### 修复

- 修复《高压下气体流量标准的比较》一点击就卡死 DSH 的问题：
  `renderMarkdown` 遇到「`$$` 与公式第一行写在同一行」时，单行/独占行两个分支都
  匹配不到，落进段落分支后 `i` 不前进，形成死循环。
- 新增「行首 `$$` + 内容」「行首 `\[` + 内容」两个块公式起始分支；
- 段落分支增加强制前进保险，未识别边界（如不完整表格行）不会再原地打转；
- `tools/test_markdown_math.mjs` 增加对应回归用例。

### 验证

- 该篇 22,638 字符渲染约 20–50ms（修复前无限等待）；
- 全库 36 篇译稿合计渲染约 407ms。

## 0.3.0 — 2026-10-19

### 新增

- 原文改用 **PDF.js canvas** 渲染，不再使用浏览器内置 PDF 阅读器：
  - host 新增 `/pdfjs/*` 白名单静态资源路由（build / worker / cmaps / fonts / wasm）；
  - `/file` 支持 **HTTP Range（206）**，大 PDF 只拉当前页附近的块；
  - 切换文献时 `PDFDocumentLoadingTask.destroy()`，确定释放 worker 与文档；
  - 自绘 35px PDF 工具条（页码、翻页、缩放、适应宽度），与译文第 2 行严格对齐；
  - PDF.js 失败时提供「兼容模式」按钮回退内置阅读器；「新窗口打开」始终可用。
- 选中项停稳后再加载（译文 120ms、PDF 400ms）；预览 HTML 8 篇 LRU 缓存。

### 验证

- Edge headless + CDP：连续渲染 6 篇 PDF 第一页 119→748ms；
- 149MB / 223 页论文第一页 181ms，未整份进内存。

## 0.2.2 — 2026-10-19

### 性能

- 切换文献时立即卸载旧 PDF iframe、中止未完成下载、revoke Blob URL；
- `/file` 改为流式返回（不整份 `readFile`），支持 HEAD；
- `doc.slug` 标记译文归属，避免旧译文闪现在新标题下；
- 预览 HTML 增加 LRU 缓存。

> 该版本的 PDF 方案后来被 0.3.0 的 PDF.js 取代；防抖与缓存策略保留。

## 0.2.1 — 2026-10-19

### 界面

- 译文区改成两行：第 1 行标题栏 40px，与「原文 PDF」标题栏同高；第 2 行
  「预览 / 源码 / 编辑」35px，与 PDF 工具条同高，两侧正文从同一水平线开始。

## 0.2.0 — 2026-10-19

### 新增

- 左栏搜索：按标题、作者、期刊、DOI、年份、分类即时过滤；
- 文献手动排序与置顶：`pinned` / `order` 字段 + `POST /reorder`；
- 阅读区上一篇 / 下一篇导航；
- 界面整体优化：条目层级、常显翻译入口、悬停操作、浅色/深色配色、滚动条与过渡。

## 0.1.0 — 2026-10-15

### 初始版本

- DSH 侧栏「文献库」图标 + 主区三栏面板（目录树 / 中文译文 / 原文 PDF）；
- PDF 抽取、DeepSeek 直连翻译、译稿预览/源码/编辑、保存与并发校验；
- 期刊信息编辑与科研通（ablesci）补全、隐藏/软删除；
- 分类树、文件夹导入、翻译进度、API 配置对话框。
