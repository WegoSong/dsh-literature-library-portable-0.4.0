# DSH 文献翻译插件——便携安装包

本包用于把“文献库 / PDF 对照阅读 / Markdown 翻译编辑 / 期刊信息补全”插件安装到另一台电脑的 DSH Web。

当前版本：**0.3.4**（左侧栏搜索、排序置顶、版本号；PDF.js 原文连续滚动；取消 PDF 页四周黑框，纸面铺满栏宽）。

## Windows 一键安装

1. 安装 **Node.js 22.13 或更高版本**，并确保目标电脑能正常启动 DSH。
2. 解压整个压缩包；不要只取出其中几个文件。
3. 双击 `安装到DSH.cmd`。
4. 完全关闭当前 DSH 进程，再重新启动。安装目录中会生成 `启动DSH.cmd`，以后可以直接使用它。
5. 打开 DSH Web，左侧应出现“文献库”。进入面板后点击“添加文件夹”导入论文。

安装器默认复制到：

```text
%USERPROFILE%\.dsh\extensions\literature-library
```

并自动修改：

```text
%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml
```

修改前会生成带时间戳的备份。若设置了 `DSH_HOME`，以上路径会自动改用该目录。

## macOS / Linux

在解压目录执行：

```bash
node install.mjs
```

然后重启 DSH Web。

## API key

安装包不会包含原电脑上的密钥。进入文献库面板，点击“配置 API”填写 DeepSeek API key；也可以设置环境变量：

```text
DEEPSEEK_API_KEY=你的密钥
```

## 更新

用新版本便携包再次运行安装器即可。安装器会更新插件和运行时，但不会覆盖已经存在的 `library/` 文献库。

## 卸载

Windows 双击 `从DSH卸载.cmd`，或者执行：

```bash
node uninstall.mjs
```

默认只注销 DSH 配置并保留文献数据。若需要把安装目录一起移到 DSH 的可恢复回收目录：

```bash
node uninstall.mjs --remove-files
```

## 自定义安装位置

```bash
node install.mjs --target "D:/Apps/dsh-literature-library"
```

也可以显式指定 profile：

```bash
node install.mjs --profile "D:/dsh-home/profiles/web/cordis.patch.yml"
```

## 包内不包含的内容

- 原电脑的 PDF、译文和文献数据库；
- DeepSeek API key 或其它 DSH 凭据；
- DSH 主程序本身。

PDF.js、KaTeX、插件运行脚本和空白文献库模板已经随包附带，不需要额外执行 `npm install`。
