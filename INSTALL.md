# 从零安装 DSH 文献库插件

本文从 **DSH 已经安装好、能打开 Web 界面** 开始，带你安装「DSH 文献库」插件（`dsh-literature-library`），并完成第一次导入和翻译配置。

- 插件版本：**0.6.0**（翻译降本 + 主题跟随）
- 仓库：<https://github.com/WegoSong/dsh-literature-library-portable-0.4.0>
- 适用：DSH Web `0.2.1-rc.2` 到 `0.3.0` 之前（市场索引声明 `>=0.2.1-rc.2 <0.3.0`）
- 平台：Windows 10/11、macOS、Linux

> 教程里的界面文字以当前中文 DSH 为准；不同版本可能略有差异。
>
> 开始前请确认：浏览器能打开 DSH，例如 <http://127.0.0.1:3080>。

---

## 目录

1. [安装前置工具](#1-安装前置工具)
2. [选择一种安装方式](#2-选择一种安装方式)
3. [第一次启动与使用](#3-第一次启动与使用)
4. [迁移旧文献库](#4-迁移旧文献库)
5. [升级与卸载](#5-升级与卸载)
6. [常见报错](#6-常见报错)
7. [数据与安全](#7-数据与安全)

---

## 1. 安装前置工具

DSH 的插件安装依赖 **pnpm**；从 GitHub 安装还需要 **Git**。这两个工具必须在启动 DSH 之前就可用，或者安装后重启 DSH，让 DSH 进程重新读取 PATH。

### 1.1 Windows：安装 pnpm

先打开 **cmd**（不是 PowerShell），执行：

```cmd
pnpm.cmd -v
```

- 能输出版本号（例如 `12.14.0`）：已安装，跳到 1.2。
- 提示“不是内部或外部命令”：继续安装。

安装 pnpm：

```cmd
npm.cmd install -g pnpm
```

然后确认：

```cmd
pnpm.cmd -v
```

> **为什么用 `npm.cmd` / `pnpm.cmd`？**
> Windows PowerShell 可能把 `npm` 解析成 `npm.ps1`，被执行策略拦住，报
> “无法加载文件 …npm.ps1，因为在此系统上禁止运行脚本”。
> 用 `.cmd` 后缀可以绕过；DSH 自己调用的是 `pnpm` 的 cmd 入口，不受影响。
>
> 如果安装后仍然找不到，检查 `%APPDATA%\npm` 是否在 PATH 里。

### 1.2 Windows：安装 Git

执行：

```cmd
git --version
```

没有输出或提示找不到命令，就安装 **Git for Windows**：

<https://git-scm.com/download/win>

安装时保持默认选项即可。安装完重新打开 cmd，确认：

```cmd
git --version
git ls-remote https://github.com/WegoSong/dsh-literature-library-portable-0.4.0.git
```

第二条命令能列出 `HEAD` 和 `refs/heads/main`，说明 Git 可以访问 GitHub。

> 如果浏览器能打开 GitHub，但 `git ls-remote` 报
> `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`，
> 执行一次：
>
> ```cmd
> git config --global http.sslBackend openssl
> ```
>
> 然后重新执行 `git ls-remote`。

### 1.3 macOS / Linux

```bash
node -v
npm install -g pnpm
pnpm -v
git --version
git ls-remote https://github.com/WegoSong/dsh-literature-library-portable-0.4.0.git
```

没有 Git 时：

- macOS：`xcode-select --install`
- Debian/Ubuntu：`sudo apt install git`
- Fedora：`sudo dnf install git`

### 1.4 装了工具但 DSH 仍找不到

DSH 是已经启动的进程，不会自动获得新装的 PATH。**完全退出 DSH 后重新启动**（不是只刷新浏览器页面），再安装插件。

如果 DSH 是用另一个 Windows 用户或服务启动的，要确保那个用户也能执行 `pnpm.cmd` 和 `git`。

---

## 2. 选择一种安装方式

三种主要方式选一种即可，推荐 **方式 A（Discover 市场）**；方式 D 是可选命令行走法。

### 方式 A：从 Discover 市场安装（推荐）

1. 打开 DSH 左侧 **插件**。
2. 切到 **发现 / Discover**。
3. 在“市场源 / 插件源”输入框里添加 **市场索引 JSON 地址**：

```text
https://raw.githubusercontent.com/WegoSong/dsh-literature-library-portable-0.4.0/main/market/index.json
```

如果 raw 地址打不开，改用 jsDelivr：

```text
https://cdn.jsdelivr.net/gh/WegoSong/dsh-literature-library-portable-0.4.0@main/market/index.json
```

4. 等待索引读取完成，找到 **DSH 文献库** 卡片。
5. 点 **安装**，等待 pnpm 完成。
6. 安装结束后 **重启 DSH**。

> **不要把 Git 仓库地址填进 Discover 的市场源输入框。**
> 那个输入框只接受返回 JSON 的市场索引；填 `.git` 地址会报“无法读取索引”。

### 方式 B：直接填 GitHub 仓库地址

1. 打开 **插件 → 已安装**。
2. 点 **添加插件**。
3. 在输入框填：

```text
https://github.com/WegoSong/dsh-literature-library-portable-0.4.0.git
```

市场索引会自动固定到对应版本的提交；手动 Git 安装用上面的仓库地址即可。

4. 点 **安装**，等待完成。
5. **重启 DSH**。

> **不要把市场索引的 raw JSON 地址填进“添加插件”。**
> 添加插件只接受包名、Git 仓库地址、tarball 或本地目录；填 raw 地址会报
> `a URL must point at a git repository or a tarball`。

### 方式 C：本地 tarball（不需要 GitHub）

如果那台电脑访问 GitHub 不稳定，先下载：

<https://github.com/WegoSong/dsh-literature-library-portable-0.4.0/releases/download/v0.6.0/dsh-literature-library-0.6.0.tgz>

把 `.tgz` 复制到目标电脑，然后：

1. **插件 → 已安装 → 添加插件**。
2. 填 tarball 的绝对路径，例如：

```text
D:\dsh-literature-library-0.6.0.tgz
```

3. 点 **安装**，等待完成。
4. **重启 DSH**。

这种安装方式不需要 Git，也不需要访问 GitHub；但 pnpm 仍需要从 npm registry 下载 `pdfjs-dist` 等依赖。

### 方式 D：命令行安装（可选）

在已经能运行 `dsh` 的终端里：

```bash
dsh plugin add "git+https://github.com/WegoSong/dsh-literature-library-portable-0.4.0.git"
```

或本地 tarball：

```bash
dsh plugin add "D:/dsh-literature-library-0.6.0.tgz"
```

安装完成后重启 DSH Web。

---

## 3. 第一次启动与使用

### 3.1 重启 DSH

插件的 host 半边只在 DSH 进程启动时加载。安装完必须**完全退出 DSH 再启动**；仅刷新浏览器不够。

重启后，左侧栏应出现一个**书本图标**（文献库）。点击它，主区切换到文献库面板。

### 3.2 数据目录

市场安装默认把数据放在：

**Windows**

```text
C:\Users\<你的用户名>\.dsh\literature-library\library
```

**macOS / Linux**

```text
~/.dsh/literature-library/library
```

首次启动会自动创建：

```text
library/
  library.json
  index.json
  papers/
  translations/
  extracted/
  trash/
```

- `papers/`：PDF 原文
- `translations/`：中文译稿
- `extracted/`：从 PDF 抽取的文本
- `trash/`：软删除的 PDF

### 3.3 导入 PDF

推荐用左栏顶部的 **「＋ 导入」**：

1. 选择包含 PDF 的文件夹。
2. 插件会把 PDF **复制**到 `library/papers/<文件夹名>/`，并保留子目录层级作为分类。
3. 导入完成后，左侧出现分类树。

如果你已经手动把 PDF 放进了 `library/papers/`，也可以用工具条的 **「扫描」** 登记，输入库内相对路径（默认 `library/papers`）。

### 3.3.1 扫描某个分类的新增文献

例如「参考文献」是从 `E:\Wego\科研项目\高温高压氦气黏度\参考文献` 导入的：

1. 在左侧目录树点击 **参考文献** 分类标题；它会高亮，扫描行变成「扫描：参考文献」。
2. 点 **扫描新增**。
3. 插件会读取该分类导入时记录的**原始外部文件夹**，扫描里面的新增 PDF，
   复制到 `library/papers/参考文献/`（保留子目录），并登记到原分类。
4. 如果选中的是嵌套分类 `参考文献/子类`，会扫描原始来源下的 `子类` 目录。
5. 点扫描行里的 `×` 取消选中，回到手动输入库内路径的模式。

> 如果提示“没有记录导入来源”，说明这个分类是手动放进库里的，不是用「＋ 导入」来的；
> 用「＋ 导入」重新导入一次该外部文件夹即可建立来源记录。

### 3.4 阅读与对照

- 左栏选择文献。
- 中栏是中文译文，右栏是原文 PDF。
- PDF 栏支持鼠标滚轮连续滚动，工具条页码会随滚动更新。
- 中栏有 **预览 / 源码 / 编辑** 三种模式；编辑后记得保存。

### 3.5 配置 DeepSeek API

翻译需要 DeepSeek API key：

1. 在 <https://platform.deepseek.com/> 创建 key。
2. 回到文献库，点工具条的 **「配置」**。
3. 粘贴 key 并保存。

key 会写入：

```text
~/.dsh/.credentials.yaml
```

写前会自动备份。也可以用环境变量：

```text
DEEPSEEK_API_KEY
```

没有 key 时，浏览、搜索、PDF 阅读仍然可用，只是不能翻译。

### 3.6 确认版本

左栏底部会显示：

```text
v0.6.0  PDF.js
```

如果显示旧版本或 `v…`，说明运行中的客户端/宿主还不是 0.6.0，需要确认安装并重启 DSH。

---

## 4. 迁移旧文献库

如果你之前用旧版便携包（`install.mjs` + zip / profile 路径行）装过插件，文献库通常在原来的工作区：

```text
E:\Wego\我的日常\自建项目\文献翻译插件\library
```

新版市场包默认使用：

```text
C:\Users\<用户名>\.dsh\literature-library\library
```

两者不是同一个目录，直接安装新包会看到**空库**。迁移有两种做法。

### 4.1 保留原目录（推荐）

先删掉旧 profile 里的路径行：

```text
C:\Users\<用户名>\.dsh\profiles\web\cordis.patch.yml
```

找到类似：

```yaml
- insert:
    - id: literature-library
      name: 'E:/.../plugin/literature-library/index.js'
      config:
        workspaceRoot: 'E:/.../文献翻译插件'
```

删除这一整条 `literature-library` 行，避免安装新包后出现两个文献库面板。

然后安装 0.6.0，再在同一个 `cordis.patch.yml` 末尾加：

```yaml
- id: literature-library
  config:
    workspaceRoot: 'E:/Wego/我的日常/自建项目/文献翻译插件'
```

`workspaceRoot` 要指向**包含 `library/` 的目录**，不是 `library` 本身。保存后重启 DSH。

### 4.2 复制数据目录

也可以把旧库复制到新数据目录：

**Windows**

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\literature-library" | Out-Null
Copy-Item -Recurse "E:\Wego\我的日常\自建项目\文献翻译插件\library" "$env:USERPROFILE\.dsh\literature-library\library"
```

复制后重启 DSH。

> 迁移前建议先备份整个 `library/`。它包含 PDF、译稿和 `library.json`，是文献库的全部数据。

---

## 5. 升级与卸载

### 5.1 更新（GitHub 在线 / 本地包，0.4.2 起）

0.4.2 起工具条有 **「更新」** 按钮；0.4.3 起同时支持两种来源：

#### 方式 1：GitHub 在线更新

1. 打开「更新」对话框。
2. 点 **检查 GitHub 更新**。
3. 如果 GitHub 上有更新版本，点 **更新到 vX**。
4. 更新完成会提示新版本号；**完全退出 DSH 后重新启动**。

> 这需要 **DSH host 进程**能访问 `github.com`。浏览器能打开 GitHub 不代表 host 能访问；
> 如果 host 走不了外网，会提示失败，直接改用下面的本地包方式即可。

#### 方式 2：本地包更新（不需要外网）

1. 从 Release、另一台电脑或 U 盘拿到新版本的 `.tgz`，例如：

   ```text
   dsh-literature-library-0.6.0.tgz
   ```

2. 任选一种：
   - **放进更新目录**：把 `.tgz` 复制到

     ```text
     C:\Users\<用户名>\.dsh\literature-library\updates\
     ```

     打开「更新」对话框，列表里会出现新版本，点 **一键更新**。
   - **直接选择文件**：打开「更新」对话框，点“选择文件”，选中 `.tgz`，再点 **上传并更新**。

3. 更新完成会提示新版本号；**完全退出 DSH 后重新启动**。

两种方式都会：

- 校验包名、版本、`dsh.bundle.patch` 和必要文件；
- 更新前备份旧文件到：

  ```text
  .dsh\literature-library\updates\backup-<旧版本>-<时间>\
  ```

- 失败自动回滚；只覆盖程序文件，不删除 `library/`。

> **0.4.1 及更早版本没有「更新」按钮**，需要先手动安装一次 0.4.2 或 0.6.0
> （方式 A/B/C 均可）。之后才能使用更新入口。
>
> 更新包必须是 `npm pack` 生成的 `.tgz`，且版本号高于当前版本；不会接受降级或同名版本。

### 升级

1. **插件 → 已安装**，先卸载旧版（卸载程序不会删除文献库数据）。
2. 用方式 A/B/C 安装新版。
3. 重启 DSH。
4. 看左栏底部版本号确认。

### 卸载

在 **插件 → 已安装** 里卸载「DSH 文献库」。

数据目录不会自动删除；确认不再需要时，手动删除：

```text
~/.dsh/literature-library
```

---

## 6. 常见报错

| 报错 | 原因 | 处理 |
|---|---|---|
| `'pnpm' 不是内部或外部命令` | pnpm 没装，或 DSH 进程 PATH 里没有 | 安装 pnpm，彻底重启 DSH |
| `pnpm` 在 PowerShell 里报执行策略 | PowerShell 选中了 `pnpm.ps1` | 用 `pnpm.cmd -v`；DSH 安装不受影响 |
| `spawn git ENOENT` / `git 不是内部或外部命令` | Git 没装，或 DSH 进程找不到 Git | 安装 Git；把 `C:\Program Files\Git\cmd` 加入 PATH；重启 DSH |
| 浏览器能开 GitHub，DSH 报“无法连接 github.com” | DSH 进程没有继承 Git/PATH，或 Git 的 SSL/代理不对 | 重启 DSH；试 `git config --global http.sslBackend openssl`；必要时配 Git 代理 |
| `a URL must point at a git repository or a tarball` | 把市场索引 raw 地址填进了“添加插件” | 改用 Git 仓库地址 / tarball；索引地址填到 Discover |
| `无法读取索引` | 把 Git 仓库地址填进了 Discover 市场源 | 改用 `market/index.json` 的 raw / jsDelivr 地址 |
| 安装后出现两个文献库面板 | 旧的 profile 路径行还在 | 删除旧 `literature-library` 路径行，重启 |
| 安装后是空库 | 新包默认数据目录和旧工作区不同 | 配 `workspaceRoot`，或复制旧 `library/` |
| 翻译报 401/403 | DeepSeek key 没配/无效 | 工具条「配置」里重新保存 key |
| `ERR_PNPM_FETCH_404` / 下载依赖失败 | npm registry / 代理问题 | 检查 pnpm registry，或改用可用镜像 |
| PDF 页空白 | host 的 `/pdfjs` 未加载或浏览器缓存 | 重启 DSH，强制刷新浏览器，看控制台 |
| 安装时提示 DSH 版本不兼容 | DSH 版本不在 `>=0.2.1-rc.2 <0.3.0` | 升级/降级 DSH，或改索引的 `engines.dsh` |

---

## 7. 数据与安全

- 插件在本机以你的用户权限运行；PDF、译稿、API key 都保存在本机。
- 只有翻译时，文本会发送到 DeepSeek API；补全期刊信息时会访问科研通（ablesci）。
- DSH Web 默认没有登录鉴权，建议只监听本机 `127.0.0.1`，不要把 3080 直接暴露到公网。
- 文献库是自包含的：备份/迁移只需要复制 `library/` 目录。
- 插件升级/卸载不会自动删除 `library/`；这是有意的，避免误删长期积累的数据。

---

## 相关链接

- 仓库：<https://github.com/WegoSong/dsh-literature-library-portable-0.4.0>
- 变更记录：[CHANGELOG.md](CHANGELOG.md)
- 维护者文档：[README-plugin.md](README-plugin.md)
- 市场索引：[market/index.json](market/index.json)
