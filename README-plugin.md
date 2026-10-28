# DSH Literature Library（市场安装包）

> **从零开始安装**：安装完 DSH 后不知道下一步怎么做？请看
> [INSTALL.md](INSTALL.md)（前置工具、三种安装方式、首次使用、旧数据迁移、常见报错）。

这是可在 **DSH Web → Plugins** 中安装的 bundle 包，不再需要 `install.mjs` 或手工改
`cordis.patch.yml`。

## 0.10.0：按页分区与翻译

PDF 页码下的「页面任务」分别选择 AI 分区、本地分区、翻译的全部/指定页数，例如 `1-5,8,12-20`。采用从 1 开始的 PDF 实际页序。分区只替换目标页，其他页和人工修改保留；目标页人工框会在明确确认后替换。未完成页暂缓翻译，AI 停止后完成页仍可使用，不自动付费翻译。选页译稿另存，标记不是全文；范围和开关在同一客户端按篇记忆。

## 0.9.0：常用设置与 DSH 账号

左侧常驻「分区」引擎及「AI 设置」。设置中选择 API Key 或 DSH 登录账号，再保存视觉模型和单价；账号必须先在 DSH 登录/启用，其路由缺失时选项会禁用。账号与 API 价格分别保留，不假定网页订阅等同 API 余额；插件不读取 token、无自动凭据回退。分区与翻译启动仍会确认发送与费用。

阅读布局、专注、详情和分区显示选项在同一客户端保留，连同既有字号/栏宽/媒体/阅读位置。窄屏不会覆盖双栏偏好。分区对应浮窗和连线只完成独立设计，尚未正式接入。

## 保留功能

已修复「更多」内复选框/按钮无法点击及坐标、PDF 工具焦点误关闭。升级并重启 DSH/刷新插件页面即可，无须重新翻译。

- 「文献管理」：扫描路径、文件夹整理、隐藏与信息补全。
- 「翻译与任务」：自动/半自动/手动、图表与公式选项、批量分区队列。
- 「阅读设置」：分档字号，仍会记住上次设置；不影响分区编辑器。
- PDF 栏「工具」：查找和打印；「分区」：预览、纠错、确认后翻译。
- 旧分区应用升级会保留人工框，但需重新检查。已有译文不会自动覆盖、重译或扣费。
- 分区工具使用“选择分区 → 修改类型 → 保存”，坐标与高级动作收进展开项；旧稿点击「更新识别」，图表题注与公式按实际抽取结果显示。
- 本版本保留完整性审计；问题页先纠错再翻译。不保证扫描件/复杂矩阵全部自动准确，目标笔记本和真实模型效果仍需复测。

## 安装

### 方式 A：本地 tarball（最快）

1. 打开 DSH Web 左侧 **Plugins**；
2. **Add plugin → Install a third-party plugin**；
3. 包源填写 `.tgz` 的绝对路径，或解压后的目录绝对路径；
4. 安装后启用 `dsh-literature-library`，重启 DSH Web。

对应的 CLI 写法：

```powershell
dsh plugin add "E:/path/to/dsh-literature-library-0.7.2.tgz"
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
