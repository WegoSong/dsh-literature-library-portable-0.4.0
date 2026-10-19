# DSH Literature Library（市场安装包）

这是可在 **DSH Web → Plugins** 中安装的 bundle 包，不再需要 `install.mjs` 或手工改
`cordis.patch.yml`。

## 安装

### 方式 A：本地 tarball（最快）

1. 打开 DSH Web 左侧 **Plugins**；
2. **Add plugin → Install a third-party plugin**；
3. 包源填写 `.tgz` 的绝对路径，或解压后的目录绝对路径；
4. 安装后启用 `dsh-literature-library`，重启 DSH Web。

对应的 CLI 写法：

```powershell
dsh plugin add "E:/path/to/dsh-literature-library-0.4.0.tgz"
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
