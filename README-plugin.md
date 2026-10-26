# DSH Literature Library（市场安装包）

> **从零开始安装**：安装完 DSH 后不知道下一步怎么做？请看
> [INSTALL.md](INSTALL.md)（前置工具、三种安装方式、首次使用、旧数据迁移、常见报错）。

这是可在 **DSH Web → Plugins** 中安装的 bundle 包，不再需要 `install.mjs` 或手工改
`cordis.patch.yml`。

## 0.7.0 操作入口

- 「文献管理」：扫描路径、文件夹整理、隐藏与信息补全。
- 「翻译与任务」：自动/半自动/手动、图表与公式选项、批量分区队列。
- 「阅读设置」：分档字号，仍会记住上次设置；不影响分区编辑器。
- PDF 栏「工具」：查找和打印；「分区」：预览、纠错、确认后翻译。
- 旧分区应用升级会保留人工框，但需重新检查。已有译文不会自动覆盖、重译或扣费。
- 本版本保留完整性审计；问题页先纠错再翻译。不保证扫描件/复杂矩阵全部自动准确，目标笔记本和真实模型效果仍需复测。

## 安装

### 方式 A：本地 tarball（最快）

1. 打开 DSH Web 左侧 **Plugins**；
2. **Add plugin → Install a third-party plugin**；
3. 包源填写 `.tgz` 的绝对路径，或解压后的目录绝对路径；
4. 安装后启用 `dsh-literature-library`，重启 DSH Web。

对应的 CLI 写法：

```powershell
dsh plugin add "E:/path/to/dsh-literature-library-0.7.0.tgz"
```

### 方式 B：插件市场

1. 把 tarball 发布到 npm（公开或私有 registry），或把包推到 Git 仓库；
2. 修改 `index.json` 的 `versions[0].source`（`npm` 或 `git`）与 `publishTimestamp`；
3. 把 `index.json` 放到一个 http(s) 地址；
4. DSH → Plugins → Discover → 添加该 market index URL。

> 市场索引只接受 **npm** 或 **git** 源；本地 `.tgz` 请用方式 A。

## 数据放在哪

市场包只带程序，不带 PDF/译文/密钥。首次启动会自动创建：

```text
<DSH_HOME>/literature-library/library/
    library.json
    index.json
    papers/  translations/  extracted/  trash/
```

`DSH_HOME` 默认是 `%USERPROFILE%\.dsh`（Windows）或 `~/.dsh`。

如果已经有一个工作区文献库，在 profile 的 `cordis.patch.yml` 里加：

```yaml
- id: literature-library
  config:
    workspaceRoot: 'E:/path/to/existing/library-workspace'
```

## 功能

分类 PDF 库、搜索、手动排序/置顶、中文译文 + PDF.js 连续滚动对照、DeepSeek 翻译、
Markdown 编辑、期刊信息补全、版本号显示。详见包内 `README.md` 与 `CHANGELOG.md`。

## 依赖

- DSH `>= 0.2.1-rc.2 < 0.3.0`
- Node.js `>= 22.13`
- **pnpm**（DSH 的 Plugins/市场安装用它；例如 `npm install -g pnpm`）
- `pdfjs-dist`（安装时由 pnpm 自动装）

## 版面检查（0.6.7 起）

翻译前先在本地识别区域和阅读顺序。缺少 Abstract 标签的侧边摘要由页面底板、文字与引言位置共同推断，并提示核对；不会为了识别区域额外调用付费视觉服务。独立公式仍优先显示原 PDF 局部图像，而非猜测 LaTeX。

抽取目录新增 `<slug>.layout.md` 和 `<slug>.layout.json`，保存区域、原页坐标、稳定文字项编号、段落类型、跨页来源和覆盖检查。文字项遗漏/重复，或无法可靠分开的并列正文，会停止付费翻译并保留诊断；覆盖检查通过只证明原文文字项没有丢失或重复，不保证语义和翻译质量。

开发工作区可只核对少量页，无需翻译全文：

```powershell
node plugin/literature-library/tools/extract_pdf.mjs "论文.pdf" --out "output/layout-review" --name "sample" --pages 1-6 --preview-pages 1,5,6
```

预览输出到 `output/layout-review/sample/layout/`，蓝框为正文阅读流，棕框为摘要，紫框为作者或出版信息；框上数字表示正文区域顺序。预览按需生成、逐页释放，不常驻浏览器。页面旋转、扫描件、复杂表格和未被规则覆盖的布局仍需核对，尚未接入视觉模型兜底。

更新不自动重译已有译稿。请先检查样例版面，再手动重译确认；重译可能调用 API 并产生费用。反馈时提供原 PDF、原页码、错误译文截图和对应 `.layout.md`，无需提供密钥、Cookie 或完整浏览器 HAR。

### 0.6.8 校验与诊断

字间距摘要标题、并排 ARTICLE INFO 以及高于传统页脚的独立出版信息带也参与分区。行内变量允许同段自然语序调整，但不允许缺失、重复、改写或跨段/跨独立公式移动；这只是结构完整性检查，不能替代科学内容核对。

参考文献识别同时检查连续编号、作者缩写、年份和卷页信息，支持长作者列表及粘连多条。文献表继续本地保留，不送给翻译模型。更新保留未变分块的缓存兼容性，实际是否命中取决于源文、模型及提示词是否相同。

若再次校验失败，最近的错误片段保存在 `library/logs/translation-failures/<文献哈希>/`：包含原片段、模型返回、具体错误和技术标记；不记录请求头或凭据。文件仅留在本地，可能包含论文正文，分享前请确认内容适合公开。反馈通常只需出错页码和对应诊断文件，不需要浏览器网络抓包。

### 0.6.9 分区工作台

左栏选择「自动分区翻译 / 半自动·人工检查 / 手动分区」，默认半自动。PDF 工具栏「分区」可展开工具，分区框可单独显示或隐藏；收起后不占阅读高度。

- 自动：点击翻译或在「分区/批量翻译」中勾选论文，提交分区。自检通过后自动翻译；复杂页面或无文字层会暂停。自检是本地规则与文字完整性审计，不是视觉大模型的语义复核。
- 半自动：批量勾选 → 分区选中 → 打开一篇检查 → 必要时手动纠错 → 此页已检查/确认整篇 → 按确认分区翻译。也可全部检查后在队列中「确认已检查选中」，再「翻译已确认选中」。已有分区不会被批量覆盖；重做在单篇 PDF 工具里明确确认。
- 手动：先生成原生文字底稿，再对每页保存人工分区。可清空本页重画、移动/缩放框、修改类型，使用「提前/后移」调整顺序；每个原文文字项必须有且只有一个所属区，非正文须归入作者/出版信息或忽略区。若只想重画少数问题页，使用半自动模式即可。

本地分区、预览、人工保存和检查不产生模型 token；「翻译」或自动模式自检后的提交才可能产生 API 费用。公式原图本地保存。旋转/裁剪坐标页目前阻止翻译；扫描件需先 OCR，画框本身不会识字。复杂表格仍需人工核对。

状态保存在 `library/layouts/<文献>/state.json`，分区每次修改建立新版本，旧版目录保留。手动修改、PDF 改变或抽取稿变动会阻止过期确认；已排队/正在翻译时不能修改。分区任务重启后若被中断，需点击重新分区；已完成的分区和逐页检查记录仍保留。不要直接手改内部 state 文件。

开发测试：`node tools/test_layout_workflow.mjs`、`node tools/test_manual_pdf_regions.mjs`。真实浏览器夹具 `tools/layout_ui_harness.mjs` 使用独立临时文献库并阻断外部 API；React 测试依赖仅安装在 `output/layout-ui-test-deps/`，不进入发布包。浏览器验证不等于真实 API 翻译质量或其他电脑内存验证。

### 0.6.10 分区界面修复

分区工具现在位于 PDF 下方，不遮挡论文；工具区限高且独立滚动，详细说明默认收起。模式选择、类型和边界输入使用紧凑字号，不受论文阅读字号影响。原来的阅读字号、阅读位置和已保存分区不变。

升级会刷新当前页面中的插件样式，避免旧样式残留。安装更新后仍需完整重启 DSH 以加载新版本代码。开发回归增加 `node tools/test_layout_ui_css.mjs`；浏览器夹具默认模拟旧样式残留、宿主大字号干扰和高阅读字号，以验证 PDF 不会被分区工具挤没。
