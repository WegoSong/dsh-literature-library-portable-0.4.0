/**
 * dsh-literature-library —— host 半边。
 *
 * 职责：把一组**只读 + 两个动作**的 HTTP 路由挂到 DSH 的 Web 服务器上，
 * 供浏览器端面板使用。
 *
 *   GET  /literature-library/index               → library/index.json（文献库索引）
 *   GET  /literature-library/file?path=<相对路径> → 工作区内的文件（PDF/译稿/抽取文本）
 *   POST /literature-library/scan                → 递归扫描目录，按子文件夹分类登记 PDF
 *   POST /literature-library/translate           → 为某篇文献创建翻译会话并投递提示词
 *
 * 为什么不让客户端直接做：主区面板（`main` 槽）拿不到 Session，
 * 因而用不了 `workspaceFiles` Remote（它要 sessionId 授权）；`dsh-resource://` 又是
 * DSH 内部的虚拟资源地址，fetch 取不到。所以由 host 提供同源路由。
 *
 * 安全边界：
 *   - 文件读取只允许 `<workspaceRoot>/<libraryDir>` 之下，并做前缀校验阻断 `..`；
 *   - `/scan` 与 `/translate` 只接受 `libraryDir` 之下的路径。
 */

import { readFile, stat, readdir, writeFile, mkdir, copyFile, rename, rmdir } from 'node:fs/promises';
import {
  copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync,
  readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { resolve, join, extname, sep, normalize, relative, basename, dirname, parse } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { homedir as osHomedir } from 'node:os';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';

/** 插件的展示名（cordis 用于日志与诊断）。 */
export const name = 'literature-library';

/** 需要 webServer 服务；没有它就不加载（例如 headless profile）。 */
export const inject = ['webServer'];

/**
 * 插件自身的 package.json —— 版本号的**唯一事实来源**。
 * 界面上的 `vX.Y.Z` 由 `/version` 读取这里，避免在客户端再硬编码一份。
 */
const PLUGIN_PACKAGE = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  } catch {
    return { name: 'dsh-literature-library', version: '0.0.0' };
  }
})();
const PLUGIN_VERSION = typeof PLUGIN_PACKAGE.version === 'string'
  ? PLUGIN_PACKAGE.version : '0.0.0';

// ─────────────────── 离线更新包（.tgz）───────────────────

/** 读取 tar 头里的 NUL 结尾字符串。 */
function tarString(buf, start, length) {
  return buf.subarray(start, start + length).toString('utf8').replace(/\0.*$/u, '').trim();
}

/**
 * 解析 npm pack 生成的 `.tgz`，返回 **去掉 `package/` 前缀后** 的文件 Map。
 * 不依赖系统 tar，Windows/macOS/Linux 行为一致；同时阻断路径穿越。
 */
function readUpdateTarGz(buffer) {
  const tar = gunzipSync(buffer, { maxOutputLength: 64 * 1024 * 1024 });
  const files = new Map();
  let offset = 0;
  let total = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const full = (prefix ? `${prefix}/${name}` : name).replace(/\\/g, '/');
    const size = Number.parseInt(tarString(header, 124, 12) || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    if (!Number.isFinite(size) || size < 0) throw new Error('更新包 tar 头损坏');
    const dataStart = offset + 512;
    if (dataStart + size > tar.length) throw new Error('更新包内容不完整');
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (type !== '0' && type !== '\0') continue; // 目录/PAX/链接一律跳过
    const normalized = full.replace(/^\.\/+/u, '');
    if (!normalized.startsWith('package/')) throw new Error('更新包必须是 npm pack 的 package/ 结构');
    const rel = normalized.slice('package/'.length);
    if (rel === '' || rel.startsWith('../') || rel.includes('/../') || rel.startsWith('/')) {
      throw new Error(`更新包包含非法路径：${full}`);
    }
    total += size;
    if (total > 64 * 1024 * 1024) throw new Error('更新包解压后过大');
    if (files.size > 5000) throw new Error('更新包文件数量过多');
    files.set(rel, tar.subarray(dataStart, dataStart + size));
  }
  if (!files.has('package.json')) throw new Error('更新包缺少 package.json');
  return files;
}

function isValidVersion(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value);
}

/**
 * 用新文件替换目标文件，而不是在原文件上覆盖。
 * pnpm 的包文件常是 store 的硬链接；原文件上写入会改到 store 里的共享副本。
 * 先写临时文件再 rename，可以断开硬链接，只替换当前安装目录。
 */
function replaceFileSync(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = join(dirname(dest), `.${basename(dest)}.ll-update-${process.pid}-${Date.now()}`);
  copyFileSync(src, tmp);
  try {
    try {
      renameSync(tmp, dest);
    } catch {
      rmSync(dest, { force: true });
      renameSync(tmp, dest);
    }
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

/** 只需判断升级方向；预发布版本按数字段比较，足够本插件使用。 */
function compareVersions(a, b) {
  const split = (v) => String(v).split('-')[0].split('.').map((n) => Number(n) || 0);
  const x = split(a); const y = split(b);
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? 1 : -1;
  }
  return String(a) === String(b) ? 0 : (String(a) > String(b) ? 1 : -1);
}

/**
 * 可选配置（不导出 Config schema，因此行里的 `config:` 会原样传入 apply）：
 *   workspaceRoot  工作区根目录；**留空时自动探测**
 *   libraryDir     文献库子目录，默认 'library'
 *   papersDir      PDF 存放目录（相对 libraryDir），默认 'papers'
 *   routePrefix    路由前缀，默认 '/literature-library'
 *   agentPreset    创建翻译会话时用的 preset（可选）
 *   allowFileSystemBrowse  是否允许面板浏览文件系统（默认 true）。
 *                  置为 false 可关闭 `/browse`——该路由能列出任意目录的**子目录名**
 *                  （不含文件内容），而 DSH 的 web 服务器自身不带鉴权，
 *                  所以只在自己机器上用；多人共用时建议关掉。
 *   dshModulesRoot DSH 的 node_modules 目录（可选）。「一键翻译」需要从内核里取
 *                  createUserMessage/SessionId；插件本身在工作区，无法直接解析这些包，
 *                  因此按「显式配置 → 环境变量 DSH_MODULES_ROOT → require 解析 → 入口路径」
 *                  的顺序定位内核。从 npx 缓存启动时通常无需配置。
 *
 * 关于自动探测：host 半若直接用 `process.cwd()`，得到的是**启动 `dsh web` 时所在的目录**。
 * 从用户主目录启动时它会是 `%USERPROFILE%`，于是找不到 `library/index.json`。
 * 因此这里依次尝试多个候选，取第一个**真的含有 `<libraryDir>/index.json`** 的。
 */

/**
 * 删除文献时，这些分类即使空了也保留（它们是库的固定分类表，不是自动建的）。
 * 与 `tools/library_index.mjs` 的 DEFAULT_CATEGORIES 保持一致。
 */
const DEFAULT_KEEP_CATEGORIES = [
  '热物性', '传感器', '自供电', '机械', '材料', '热物理', '计算机', '其他',
];

const MIME = {  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  // PDF.js 运行时资源
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.icc': 'application/octet-stream',
};

// ─────────────────── DSH 内部模块解析 ───────────────────

const requireFromHere = createRequire(import.meta.url);

/**
 * 解析并动态导入 DSH 自己的包（如 `@deepseek-ai/dsh-llm`）。
 *
 * 难点：插件的 host 半生活在**工作区**里，工作区并没有装 `@deepseek-ai/*`；
 * 而那些包在 DSH 自己的安装目录（npx 缓存）里。所以不能直接 `import` 包名。
 *
 * 策略：**先定位 DSH 内核包**（`@deepseek-ai/dsh`），再以它所在目录为锚点解析其它包。
 * 内核位置通过三个独立信号推断，任一成功即可：
 *   1. 从本模块解析（插件若由 DSH 直接加载，这条就成立）
 *   2. 从 DSH 的可执行入口（`process.argv[1]`）解析
 *   3. 沿 `node_modules/@deepseek-ai/dsh` 路径特征回推（npx 缓存布局）
 * 这样即便插件位于工作区、由路径行加载，也能拿到内核里的接口。
 */
function locateDshRoot(configuredRoot) {
  const tried = [];

  // 0) 显式配置 / 环境变量：最可靠，也是部署时推荐做法
  for (const candidate of [configuredRoot, process.env.DSH_MODULES_ROOT]) {
    if (typeof candidate !== 'string' || candidate.trim() === '') continue;
    const abs = resolve(candidate);
    tried.push(abs);
    // 允许两种写法：直接给 node_modules，或给包含 @deepseek-ai 的目录
    if (existsSync(join(abs, '@deepseek-ai')) || existsSync(join(abs, 'node_modules', '@deepseek-ai'))) {
      return { dir: existsSync(join(abs, '@deepseek-ai')) ? abs : join(abs, 'node_modules'), how: 'explicit' };
    }
  }

  const reqs = [requireFromHere];
  if (process.argv[1]) {
    try { reqs.push(createRequire(pathToFileURL(process.argv[1]).href)); } catch { /* ignore */ }
  }

  // 1) / 2) 通过 require.resolve 找到内核包目录
  for (const req of reqs) {
    try {
      const pkg = req.resolve('@deepseek-ai/dsh/package.json');
      tried.push(pkg);
      return { dir: dirname(pkg), how: 'require.resolve' };
    } catch { /* 继续 */ }
  }

  // 3) 从入口路径里找 node_modules 特征
  const entry = process.argv[1]?.replace(/\\/g, '/') ?? '';
  const marker = '/node_modules/@deepseek-ai/dsh/';
  const at = entry.indexOf(marker);
  if (at >= 0) {
    const modules = entry.slice(0, at + '/node_modules'.length);
    tried.push(modules);
    return { dir: join(modules, '@deepseek-ai', 'dsh'), how: 'entry-path' };
  }

  return { dir: undefined, tried, how: 'none' };
}

/** DSH 内核包所在目录；在 apply() 里根据配置/环境探测后赋值。 */
let dsh = { dir: undefined, tried: [], how: 'unresolved', modules: undefined };

async function importDshModule(specifier) {
  // 测试、嵌入式宿主或特殊打包布局可以直接注入模块对象。这样插件不必依赖
  // 某个 npx 缓存绝对路径，也让宿主有机会提供与 Node 解析器隔离的 DSH API。
  if (dsh.modules && Object.hasOwn(dsh.modules, specifier)) {
    return dsh.modules[specifier];
  }
  const tried = [];
  const reqs = [];
  if (dsh.dir) {
    try { reqs.push(createRequire(pathToFileURL(join(dsh.dir, 'package.json')).href)); } catch { /* ignore */ }
  }
  reqs.push(requireFromHere);

  let lastErr;
  for (const req of reqs) {
    try {
      const resolved = req.resolve(specifier);
      tried.push(resolved);
      return await import(pathToFileURL(resolved).href);
    } catch (err) { lastErr = err; }
  }
  throw new Error(
    `无法解析 ${specifier}（DSH 内核定位方式：${dsh.how}${dsh.dir ? ` → ${dsh.dir}` : ''}）`
    + `；已尝试 ${tried.length ? tried.join(' | ') : '无'}`
    + `；原始错误：${lastErr?.message ?? '未知'}`,
  );
}

// ─────────────────── 工作区探测 ───────────────────

/** DSH 的用户数据根目录；市场安装时用来放文献库（而不是写进 node_modules）。 */
function dshHomeDir() {
  const configured = process.env.DSH_HOME;
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured);
  return join(osHomedir(), '.dsh');
}

/**
 * 市场安装的默认数据目录：`<DSH_HOME>/literature-library`。
 * 包里只带程序，不带用户 PDF；第一次启动时在这里建一个空库。
 */
function defaultDataRoot() {
  return join(dshHomeDir(), 'literature-library');
}

/**
 * 确保数据目录里有可用的空文献库。
 * 只补缺失文件，**绝不覆盖**已有 library.json / index.json。
 */
function ensureLibraryData(libraryRoot) {
  const created = [];
  for (const dir of ['papers', 'translations', 'extracted', 'trash']) {
    const abs = join(libraryRoot, dir);
    if (!existsSync(abs)) { mkdirSync(abs, { recursive: true }); created.push(dir); }
  }
  const now = new Date().toISOString();
  const categories = [...DEFAULT_KEEP_CATEGORIES];
  const dbPath = join(libraryRoot, 'library.json');
  if (!existsSync(dbPath)) {
    writeFileSync(dbPath, `${JSON.stringify({
      version: 1, updatedAt: now, categories, papers: [],
    }, null, 2)}\n`, 'utf8');
    created.push('library.json');
  }
  const indexPath = join(libraryRoot, 'index.json');
  if (!existsSync(indexPath)) {
    writeFileSync(indexPath, `${JSON.stringify({
      version: 1,
      updatedAt: now,
      categories,
      counts: {
        total: 0,
        byStatus: { reviewed: 0, translated: 0, extracted: 0, archived: 0 },
        byCategory: Object.fromEntries(categories.map((c) => [c, 0])),
      },
      papers: [],
    }, null, 2)}\n`, 'utf8');
    created.push('index.json');
  }
  const readmePath = join(libraryRoot, 'README.md');
  if (!existsSync(readmePath)) {
    writeFileSync(readmePath, '# 文献库\n\n安装完成。请在 DSH 文献库面板中使用「＋ 导入」添加 PDF。\n', 'utf8');
    created.push('README.md');
  }
  return created;
}

function detectWorkspaceRoot(configured, libraryDir) {
  const tried = [];
  const probe = (p) => {
    if (typeof p !== 'string' || p.trim() === '') return undefined;
    const abs = resolve(p);
    tried.push(abs);
    try {
      if (existsSync(join(abs, libraryDir, 'index.json'))) return abs;
    } catch { /* 不可读，试下一个 */ }
    return undefined;
  };

  if (typeof configured === 'string' && configured.trim() !== '') {
    const abs = resolve(configured);
    return { root: abs, tried: [abs], explicit: true };
  }
  const fromEnv = probe(process.env.DSH_LITERATURE_WORKSPACE);
  if (fromEnv) return { root: fromEnv, tried, explicit: false };
  const fromCwd = probe(process.cwd());
  if (fromCwd) return { root: fromCwd, tried, explicit: false };
  try {
    let dir = fileURLToPath(new URL('.', import.meta.url));
    for (let i = 0; i < 6; i += 1) {
      dir = resolve(dir, '..');
      const hit = probe(dir);
      if (hit) return { root: hit, tried, explicit: false };
    }
  } catch { /* ignore */ }
  // 从市场安装时，插件位于 profile 的 node_modules 下，周围没有 library/。
  // 此时使用用户数据目录，而不是把库建到随机的 process.cwd()。
  const dataRoot = defaultDataRoot();
  tried.push(dataRoot);
  return { root: dataRoot, tried, explicit: false, dataRoot: true };
}

// ─────────────────── 目录与命名 ───────────────────

/** 递归列出目录下所有 PDF，返回 { absPath, relToRoot: string[], file } */
async function findPdfs(root) {
  const out = [];
  async function walk(dir, parts) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) await walk(abs, [...parts, e.name]);
      else if (e.isFile() && extname(e.name).toLowerCase() === '.pdf') {
        out.push({ absPath: abs, relToRoot: parts, file: e.name });
      }
    }
  }
  await walk(root, []);
  return out;
}

function slugify(input) {
  return String(input).trim()
    .replace(/\.(pdf|md|txt|docx?)$/iu, '')
    .replace(/[\\/:*?"<>|]+/gu, '-')
    .replace(/\s+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 80);
}

// ─────────────────── 目录浏览（host 侧自己实现） ───────────────────

/**
 * 列出某个目录下的子文件夹，形状与 DSH 的 `DirectoryListing` 一致。
 *
 * 为什么不走 `remote.directoryPicker.list()`：那是 DSH 的 **Remote** 服务，
 * 只在右侧栏的 session 作用域下注入；本插件挂在 `main`（根作用域）上，
 * 拿不到它（实测报「本部署没有 directoryPicker 服务」）。
 * host 侧直接用 fs 列目录更可靠，也不依赖内部 API 的稳定性。
 *
 * @param target - 绝对路径；省略时给出起点（Windows 给盘符列表，其他平台给主目录）
 * @returns { path, home, crumbs, entries, truncated }
 */
async function listDirectory(target) {
  const homedir = osHomedir();
  const isWin = process.platform === 'win32';
  const root = isWin ? parse(homedir).root : '/';   // 例如 "C:\\" 或 "/"

  /** 从文件系统根到该目录的祖先链（每一节都可作为跳转目标） */
  function crumbsFor(abs) {
    const parts = [];
    let cur = resolve(abs);
    for (let i = 0; i < 64; i += 1) {
      parts.unshift(cur);
      const up = dirname(cur);
      if (up === cur) break;
      cur = up;
    }
    // 最前一节是文件系统根：用完整路径当名字（DSH 的约定），其余用 basename
    return parts.map((p, idx) => ({
      name: idx === 0 ? p : (basename(p) || p),
      path: p,
      hidden: false,
    }));
  }

  async function readEntries(abs) {
    let dirents;
    try {
      dirents = await readdir(abs, { withFileTypes: true });
    } catch (err) {
      throw Object.assign(
        new Error(`无法读取目录 ${abs}（${err?.code ?? err?.message ?? err}）`),
        { status: 400 },
      );
    }
    const entries = [];
    for (const d of dirents) {
      let isDir = d.isDirectory();
      if (!isDir && d.isSymbolicLink()) {
        try { isDir = (await stat(join(abs, d.name))).isDirectory(); } catch { isDir = false; }
      }
      if (!isDir) continue;
      entries.push({ name: d.name, path: join(abs, d.name), hidden: d.name.startsWith('.') });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const LIMIT = 1000;
    const truncated = entries.length > LIMIT;
    return { entries: truncated ? entries.slice(0, LIMIT) : entries, truncated };
  }

  // 未指定目标：Windows 先给盘符列表（文件夹分散在各盘时最有用）
  if (typeof target !== 'string' || target.trim() === '') {
    if (isWin) {
      const drives = [];
      for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZAB') {
        const p = `${letter}:\\`;
        try { await stat(p); drives.push({ name: p, path: p, hidden: false }); } catch { /* 盘不存在 */ }
      }
      return {
        path: root,
        home: homedir,
        crumbs: [{ name: root, path: root, hidden: false }],
        entries: drives,
        truncated: false,
      };
    }
    return { path: homedir, home: homedir, crumbs: crumbsFor(homedir), ...(await readEntries(homedir)) };
  }

  const abs = resolve(target);
  let info;
  try {
    info = await stat(abs);
  } catch {
    throw Object.assign(new Error(`路径不存在：${abs}`), { status: 404 });
  }
  if (!info.isDirectory()) throw Object.assign(new Error(`不是文件夹：${abs}`), { status: 400 });
  return { path: abs, home: homedir, crumbs: crumbsFor(abs), ...(await readEntries(abs)) };
}

// ─────────────────── 直连 DeepSeek 翻译：任务管理 ───────────────────

/**
 * 翻译任务表：`jobId → 状态对象`。
 *
 * 放内存里的理由：任务本身是进程内的临时状态，进程没了任务也就没了；
 * 而**产物（译文文件）是持久的**，重启后靠 `library.json` 的 `translation`
 * 字段恢复显示。这样比把任务队列也持久化简单得多。
 */
const translateJobs = new Map();
/** 最多保留多少条历史任务，避免长时间运行后无限增长 */
const MAX_JOB_HISTORY = 50;

function pruneJobs() {
  if (translateJobs.size <= MAX_JOB_HISTORY) return;
  const finished = [...translateJobs.entries()]
    .filter(([, j]) => j.phase === 'done' || j.phase === 'failed')
    .sort((a, b) => String(a[1].startedAt).localeCompare(String(b[1].startedAt)));
  for (const [id] of finished) {
    if (translateJobs.size <= MAX_JOB_HISTORY) break;
    translateJobs.delete(id);
  }
}

function newJobId() {
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 用工作区里的 `tools/extract_pdf.mjs` 抽取 PDF 文本。
 *
 * 注意：**必须定义在 `apply()` 内部**——它要用 `libraryRoot` / `workspaceRoot`，
 * 那两个是 apply 的局部变量。我第一版把它放在模块层，运行时报了
 * `libraryRoot is not defined`（而且是在任务已经启动之后才暴露，比较隐蔽）。
 *
 * 关于沙箱：子进程用 `stdio: 'ignore'`，不经过管道——
 * 受限环境下「父进程读子进程管道」会被拒绝（EPERM），
 * 而我们只需要它写到磁盘上的文件，不需要它的屏幕输出。
 *
 * @returns `{ mdPath, md, warning }`
 */
// ─────────────────── 会话进度读取 ───────────────────

/**
 * 工作区路径 → DSH 的会话目录名。
 * 规则（以真实目录名为准）：盘符去冒号 → 分隔符变 `-` → 每个非 ASCII 字符替换为
 * `~` + 4 位大写十六进制 → 首尾各加 `--`。
 * `我的日常` 是 `~6211~7684~65E5~5E38`（`~` 是**前缀**，不是成对包裹）。
 */
function encodeWorkspaceToDirName(abs) {
  const stripped = String(abs).replace(/^([A-Za-z]):/, '$1');
  const dashed = stripped.replace(/[\\/]+/g, '-');
  const encoded = dashed.replace(/[^\u0000-\u007F]/g, (ch) => (
    `~${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`
  ));
  return `--${encoded}--`;
}

/** 判断一个会话是不是插件创建的翻译会话 */
function isPluginSessionId(id) {
  return typeof id === 'string' && /^sess-/.test(id);
}

/**
 * 从 DSH 的凭据文件里取 API key（用于「配置是否就绪」的检查）。
 * 文件是 YAML，但我们只需其中一个键值，用针对性正则即可——不为此引入 YAML 依赖，
 * 也避免解析整份文件（里面还有别的东西）。
 */
async function readCredentialKey() {
  const file = join(
    process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : join(osHomedir(), '.dsh'),
    '.credentials.yaml',
  );
  if (!existsSync(file)) return { key: null, file };
  let text;
  try { text = await readFile(file, 'utf8'); } catch { return { key: null, file }; }
  const m = /(?:^|\n)\s*DEEPSEEK_API_KEY\s*:\s*['"]?([A-Za-z0-9_\-]{10,})['"]?\s*(?:\n|$)/.exec(text);
  return { key: m ? m[1] : null, file };
}

/**
 * 把 API key 写进 DSH 的凭据文件（`DEEPSEEK_API_KEY`）。
 *
 * 为什么写 `~/.dsh/.credentials.yaml` 而不是插件自己的配置：
 * 那是 DSH 放凭据的地方，写在那里意味着 **DSH 自己的对话与插件共用同一个 key**，
 * 也符合本机现有布局（之前已经手工放好了一个）。写之前会先备份原文件。
 *
 * 只改这一行，其余内容逐字保留——绝不整体重写 YAML（用户的加密记录不能被破坏）。
 */
async function writeCredentialKey(newKey) {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(osHomedir(), '.dsh');
  const file = join(home, '.credentials.yaml');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const hadOriginal = existsSync(file);

  let original = '';
  if (hadOriginal) {
    original = await readFile(file, 'utf8');
    await writeFile(`${file}.bak-${stamp}`, original, 'utf8');
  } else {
    await mkdir(home, { recursive: true });
  }

  const line = `DEEPSEEK_API_KEY: ${newKey}`;
  const re = /(^|\n)(\s*DEEPSEEK_API_KEY\s*:\s*['"]?[A-Za-z0-9_\-]{10,}['"]?)(\s*)(?=\n|$)/;
  let next;
  if (re.test(original)) {
    next = original.replace(re, (_m, pre) => `${pre}${line}`);
  } else {
    next = `${original.replace(/\n*$/u, '')}\n${line}\n`;
  }
  await writeFile(file, next, 'utf8');
  return { file, backup: hadOriginal ? `${file}.bak-${stamp}` : null };
}

/**
 * DSH 的会话根目录。
 * 优先用 `DSH_HOME` 环境变量（DSH 自己就是这么定位 home 的），退回 `~/.dsh`。
 * 好处：部署可以重定向；测试也能指到临时目录里造样本，不必碰真实会话。
 */
function sessionsRootDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(osHomedir(), '.dsh');
  return join(home, 'sessions');
}

/**
 * 读一个会话的进度。
 *
 * 为什么要读会话日志而不是在内存里记状态：DSH 重启后内存状态就没了，
 * 而日志是持久的；而且这能直接反映「提示词到底有没有被接受」——
 * 这正是之前「接口返回 200 但什么都没发生」最难查的地方。
 *
 * @param sessionsRoot - `~/.dsh/sessions`
 * @param workspaceRoot - 用于算出该工作区的会话目录
 * @param sessionId - 会话 id
 * @returns `{ sessionId, phase, events, bytes, mtime, detail }`
 */
async function readSessionProgress(sessionsRoot, workspaceRoot, sessionId) {
  const dir = join(sessionsRoot, encodeWorkspaceToDirName(workspaceRoot), sessionId);
  const file = join(dir, 'session.v4.jsonl.zstd');
  if (!existsSync(file)) {
    return { sessionId, phase: 'missing', events: 0, bytes: 0, mtime: null, detail: '找不到会话文件' };
  }
  let info;
  try { info = await stat(file); } catch { info = null; }

  let text;
  try {
    const buf = await readFile(file);
    text = zstdDecompressSync(buf).toString('utf8');
  } catch (err) {
    return {
      sessionId, phase: 'unknown', events: 0,
      bytes: info?.size ?? 0, mtime: info?.mtime?.toISOString() ?? null,
      detail: `解压失败：${err?.message ?? err}`,
    };
  }

  const events = text.split('\n').filter((l) => l.trim() !== '').map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  const types = events.map((e) => String(e.type ?? e.kind ?? ''));
  const phases = events.map((e) => String(e.data?.phase ?? e.phase ?? '')).filter(Boolean);
  const hasError = events.some((e) => /error|failed|cancel/i.test(JSON.stringify(e)));
  const hasAssistant = types.some((t) => /assistant/i.test(t));

  let phase = 'unknown';
  let detail = '';
  if (events.length <= 1) {
    // 只有会话头：说明提示词从未被接受（agent 没在跑）
    phase = 'queued';
    detail = '会话已建立，但还没收到提示词（agent 可能未启动）';
  } else if (hasError && events.length < 4) {
    phase = 'failed';
    detail = '事件流里出现 error/failed';
  } else if (phases.includes('idle') && hasAssistant) {
    phase = 'done';
    detail = '本轮已完成';
  } else if (phases.includes('streaming') || phases.includes('in-step') || phases.includes('step')) {
    phase = 'running';
    detail = `进行中（${phases.slice(-1)[0]}）`;
  } else {
    phase = 'running';
    detail = `${events.length} 个事件`;
  }

  return {
    sessionId,
    phase,
    events: events.length,
    bytes: info?.size ?? 0,
    mtime: info?.mtime?.toISOString() ?? null,
    lastTypes: [...new Set(types)].slice(0, 8),
    detail,
  };
}

// ─────────────────── 主入口 ───────────────────

/**
 * 注册文献库路由。
 * @param ctx - cordis 上下文，需已提供 `webServer`。
 * @param config - 见上方注释。
 */
export function apply(ctx, config = {}) {
  const libraryDir = config.libraryDir || 'library';
  const papersDir = config.papersDir || 'papers';
  const detected = detectWorkspaceRoot(config.workspaceRoot, libraryDir);
  const workspaceRoot = detected.root;
  const libraryRoot = resolve(join(workspaceRoot, libraryDir));
  const papersRoot = resolve(join(libraryRoot, papersDir));
  const pluginRoot = dirname(fileURLToPath(import.meta.url));
  /** 离线更新包目录：把 .tgz 放这里，界面就能发现并一键更新。 */
  const updatesDir = join(dshHomeDir(), 'literature-library', 'updates');
  /** GitHub 在线更新使用的仓库；可用 config.updateRepo 覆盖。 */
  const updateRepo = typeof config.updateRepo === 'string' && config.updateRepo.trim() !== ''
    ? config.updateRepo.trim()
    : 'WegoSong/dsh-literature-library-portable-0.4.0';
  /**
   * 工具脚本目录：市场安装包里自带 `tools/`；旧的“工作区路径行”安装
   * 仍然从 workspaceRoot/tools 读，两种布局都支持。
   */
  const bundledTools = join(pluginRoot, 'tools');
  const toolsRoot = existsSync(join(bundledTools, 'library_index.mjs'))
    ? bundledTools
    : join(workspaceRoot, 'tools');
  /** PDF.js 运行时：优先按包的依赖解析（市场安装），再退回工作区 node_modules */
  let pdfjsRoot;
  try {
    pdfjsRoot = dirname(requireFromHere.resolve('pdfjs-dist/package.json'));
  } catch {
    pdfjsRoot = resolve(join(workspaceRoot, 'node_modules', 'pdfjs-dist'));
  }
  const prefix = config.routePrefix || '/literature-library';
  /** 是否允许浏览文件系统（默认允许：要收的文件夹常分散在各磁盘） */
  const allowBrowse = config.allowFileSystemBrowse !== false;

  // 翻译统一经过一个小并发队列。此前批量按钮每 300ms 启动一篇，遇到限流后
  // 往往整篇重跑；默认串行既便于 DeepSeek 建立前缀缓存，也能把失败范围限制
  // 在单个块。可用 translationConcurrency 显式调到 2，但不建议更高。
  const translationConcurrency = Math.max(1, Math.min(2, Number(config.translationConcurrency) || 1));
  const translationQueue = [];
  let activeTranslations = 0;
  let translationQueueTimer = null;

  function pumpTranslationQueue() {
    if (translationQueueTimer) {
      clearTimeout(translationQueueTimer);
      translationQueueTimer = null;
    }
    translationQueue.sort((a, b) => a.notBefore - b.notBefore || a.enqueuedAt - b.enqueuedAt);
    const now = Date.now();
    while (activeTranslations < translationConcurrency) {
      const index = translationQueue.findIndex((entry) => entry.notBefore <= now);
      if (index < 0) break;
      const [entry] = translationQueue.splice(index, 1);
      activeTranslations += 1;
      Promise.resolve()
        .then(entry.execute)
        .catch(entry.onError)
        .finally(() => {
          activeTranslations -= 1;
          pumpTranslationQueue();
        });
    }
    if (translationQueue.length && activeTranslations < translationConcurrency) {
      const waitMs = Math.max(25, translationQueue[0].notBefore - Date.now());
      translationQueueTimer = setTimeout(pumpTranslationQueue, Math.min(waitMs, 2_147_000_000));
      translationQueueTimer.unref?.();
    }
  }

  function enqueueTranslation({ execute, onError, notBefore = Date.now() }) {
    translationQueue.push({ execute, onError, notBefore, enqueuedAt: Date.now() });
    pumpTranslationQueue();
  }

  // 「一键翻译」需要从 DSH 内核里取 createUserMessage / SessionId，这里先定位内核
  dsh = { ...locateDshRoot(config.dshModulesRoot), modules: config.dshModules };
  if (dsh.dir) {
    ctx.logger?.info?.(`literature-library: DSH 内核于 ${dsh.dir}（${dsh.how}）`);
  } else {
    ctx.logger?.warn?.(
      'literature-library: 未能定位 DSH 内核，/translate 将不可用。'
      + '可在配置里加 dshModulesRoot 指定 node_modules 目录。',
    );
  }

  const bootstrapped = ensureLibraryData(libraryRoot);
  if (bootstrapped.length > 0) {
    ctx.logger?.info?.(`literature-library: 已初始化数据目录 ${libraryRoot}（${bootstrapped.join(', ')}）`);
  }

  const indexExists = existsSync(join(libraryRoot, 'index.json'));
  ctx.logger?.info?.(
    `literature-library: 路由 ${prefix}；工作区 ${workspaceRoot}`
    + `${detected.dataRoot ? '（DSH 数据目录）' : detected.explicit ? '（配置指定）' : '（自动探测）'}`
    + `；工具 ${toolsRoot}；索引${indexExists ? '存在' : '不存在'}`
    + (indexExists ? '' : `；已尝试 ${detected.tried.join(' | ')}`),
  );

  // ── 工具 ──

  /** 仅允许访问库内路径 */
  function resolveInside(relPath) {
    if (typeof relPath !== 'string' || relPath === '') return undefined;
    const cleaned = normalize(relPath.replace(/\\/g, '/')).replace(/^([/\\])+/, '');
    if (cleaned.split(/[/\\]/).includes('..')) return undefined;
    const abs = resolve(join(workspaceRoot, cleaned));
    return (abs === libraryRoot || abs.startsWith(libraryRoot + sep)) ? abs : undefined;
  }

  function sendJson(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  async function readBody(req, limit = 256 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new Error('请求体过大');
      chunks.push(c);
    }
    if (size === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  async function readRawBody(req, limit = 32 * 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > limit) {
        throw Object.assign(new Error('更新包过大（上限 32 MB）'), { status: 413 });
      }
      chunks.push(c);
    }
    if (size === 0) throw Object.assign(new Error('更新包为空'), { status: 400 });
    return Buffer.concat(chunks);
  }

  /** 扫描 updates/ 下的 .tgz；只读取 package.json，不执行任何代码。 */
  function listUpdatePackages() {
    if (!existsSync(updatesDir)) return [];
    let names = [];
    try { names = readdirSync(updatesDir); } catch { return []; }
    return names
      .filter((name) => /\.(?:tgz|tar\.gz)$/iu.test(name))
      .map((file) => {
        try {
          const abs = join(updatesDir, file);
          const st = statSync(abs);
          if (!st.isFile()) return null;
          const entries = readUpdateTarGz(readFileSync(abs));
          const pkg = JSON.parse(entries.get('package.json').toString('utf8'));
          if (pkg?.name !== 'dsh-literature-library' || !isValidVersion(pkg.version)) return null;
          return {
            file,
            version: pkg.version,
            size: st.size,
            modified: st.mtime.toISOString(),
            current: compareVersions(pkg.version, PLUGIN_VERSION) === 0,
            newer: compareVersions(pkg.version, PLUGIN_VERSION) > 0,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => compareVersions(b.version, a.version));
  }

  /**
   * 用本地 `.tgz` 覆盖当前插件文件。
   *
   * 关键点：
   *   - 只接受 name=dsh-literature-library、带 dsh.bundle.patch 的 npm pack 包；
   *   - 先把旧文件完整备份到 updates/backup-*，任一步失败就回滚；
   *   - 不碰 node_modules / library，所以不需要 pnpm、GitHub 或外网。
   */
  function applyUpdateBuffer(buffer, fileName) {
    const entries = readUpdateTarGz(buffer);
    const pkg = JSON.parse(entries.get('package.json').toString('utf8'));
    if (pkg?.name !== 'dsh-literature-library') {
      throw Object.assign(new Error('更新包不是 dsh-literature-library'), { status: 400 });
    }
    if (!isValidVersion(pkg.version)) {
      throw Object.assign(new Error(`更新包版本号非法：${pkg.version}`), { status: 400 });
    }
    const direction = compareVersions(pkg.version, PLUGIN_VERSION);
    if (direction === 0) {
      throw Object.assign(new Error(`当前已经是 v${PLUGIN_VERSION}`), { status: 409 });
    }
    if (direction < 0) {
      throw Object.assign(new Error(`不允许降级：当前 v${PLUGIN_VERSION}，更新包 v${pkg.version}`), { status: 409 });
    }
    if (!pkg.dsh?.bundle?.patch || !entries.has('cordis.patch.yml')) {
      throw Object.assign(new Error('更新包缺少 dsh.bundle.patch / cordis.patch.yml'), { status: 400 });
    }
    for (const required of ['index.js', 'client.js', 'package.json']) {
      if (!entries.has(required)) {
        throw Object.assign(new Error(`更新包缺少 ${required}`), { status: 400 });
      }
    }

    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    const stagingDir = join(updatesDir, `.staging-${Date.now()}`);
    const backupDir = join(updatesDir, `backup-${PLUGIN_VERSION}-${stamp}`);
    const newPaths = [];
    mkdirSync(updatesDir, { recursive: true });
    mkdirSync(stagingDir, { recursive: true });
    mkdirSync(backupDir, { recursive: true });

    try {
      for (const [rel, data] of entries) {
        const dest = resolve(stagingDir, rel);
        if (dest !== stagingDir && !dest.startsWith(`${resolve(stagingDir)}${sep}`)) {
          throw new Error(`更新包路径越界：${rel}`);
        }
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, data);
      }

      // 备份会被覆盖的旧文件；新文件记录在 newPaths，失败时删除。
      for (const rel of entries.keys()) {
        const dest = join(pluginRoot, rel);
        if (existsSync(dest) && statSync(dest).isFile()) {
          const bak = join(backupDir, rel);
          mkdirSync(dirname(bak), { recursive: true });
          copyFileSync(dest, bak);
        } else {
          newPaths.push(rel);
        }
      }

      for (const rel of entries.keys()) {
        const src = join(stagingDir, rel);
        const dest = join(pluginRoot, rel);
        replaceFileSync(src, dest);
      }

      writeFileSync(join(updatesDir, 'last-update.json'), `${JSON.stringify({
        from: PLUGIN_VERSION,
        to: pkg.version,
        file: fileName,
        backup: backupDir,
        at: new Date().toISOString(),
      }, null, 2)}\n`, 'utf8');

      return {
        ok: true,
        from: PLUGIN_VERSION,
        to: pkg.version,
        backup: backupDir,
        restartRequired: true,
      };
    } catch (err) {
      // 回滚：恢复备份，删掉本次新增的文件。
      for (const rel of entries.keys()) {
        const bak = join(backupDir, rel);
        const dest = join(pluginRoot, rel);
        try {
          if (existsSync(bak)) {
            replaceFileSync(bak, dest);
          } else if (newPaths.includes(rel)) {
            rmSync(dest, { force: true });
          }
        } catch { /* 尽力回滚 */ }
      }
      throw err;
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  function readLastUpdate() {
    try {
      return JSON.parse(readFileSync(join(updatesDir, 'last-update.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  /** 查 GitHub 最新 release。只读 API，不下载；离线时快速失败，本地包仍可用。 */
  async function fetchGithubLatest() {
    const url = `https://api.github.com/repos/${updateRepo}/releases/latest`;
    let res;
    try {
      res = await fetch(url, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'dsh-literature-library',
        },
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      throw Object.assign(new Error(`无法连接 GitHub（${err?.message ?? err}）`), { status: 502 });
    }
    if (!res.ok) {
      throw Object.assign(new Error(`GitHub release 查询失败：HTTP ${res.status}`), { status: 502 });
    }
    const release = await res.json().catch(() => null);
    const tag = typeof release?.tag_name === 'string' ? release.tag_name.trim() : '';
    const latest = tag.replace(/^v/iu, '');
    if (!isValidVersion(latest)) {
      throw Object.assign(new Error('GitHub release 的版本号无法识别'), { status: 502 });
    }
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const asset = assets.find((a) => a?.name === `dsh-literature-library-${latest}.tgz`)
      ?? assets.find((a) => typeof a?.name === 'string' && /\.tgz$/iu.test(a.name));
    return {
      repo: updateRepo,
      tag,
      latest,
      current: PLUGIN_VERSION,
      newer: compareVersions(latest, PLUGIN_VERSION) > 0,
      releaseUrl: typeof release.html_url === 'string' ? release.html_url : null,
      assetUrl: typeof asset?.browser_download_url === 'string' ? asset.browser_download_url : null,
      size: typeof asset?.size === 'number' ? asset.size : null,
      publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
    };
  }

  async function downloadGithubUpdate() {
    const latest = await fetchGithubLatest();
    if (!latest.newer) {
      throw Object.assign(new Error(`GitHub 上已是最新版本 v${latest.latest}`), { status: 409 });
    }
    if (!latest.assetUrl) {
      throw Object.assign(new Error('GitHub release 里没有 .tgz 安装包'), { status: 404 });
    }
    let res;
    try {
      res = await fetch(latest.assetUrl, {
        headers: { 'user-agent': 'dsh-literature-library' },
        signal: AbortSignal.timeout(60000),
        redirect: 'follow',
      });
    } catch (err) {
      throw Object.assign(new Error(`下载 GitHub 安装包失败：${err?.message ?? err}`), { status: 502 });
    }
    if (!res.ok) {
      throw Object.assign(new Error(`下载 GitHub 安装包失败：HTTP ${res.status}`), { status: 502 });
    }
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > 32 * 1024 * 1024) {
      throw Object.assign(new Error('GitHub 安装包超过 32 MB'), { status: 413 });
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > 32 * 1024 * 1024) {
      throw Object.assign(new Error('GitHub 安装包超过 32 MB'), { status: 413 });
    }
    mkdirSync(updatesDir, { recursive: true });
    const fileName = `dsh-literature-library-${latest.latest}.tgz`;
    writeFileSync(join(updatesDir, fileName), buffer);
    return applyUpdateBuffer(buffer, fileName);
  }

  async function loadDb() {
    const p = join(libraryRoot, 'library.json');
    if (!existsSync(p)) return { path: p, db: { papers: [], categories: [] } };
    return { path: p, db: JSON.parse(await readFile(p, 'utf8')) };
  }

  async function saveDb(db, dbPath) {
    db.updatedAt = new Date().toISOString();
    await writeFile(dbPath, `${JSON.stringify(db, null, 2)}\n`, 'utf8');
  }

  /**
   * 重新生成 `library/index.json`（面板读的就是它）。
   *
   * **每个写操作之后都必须调用**：早先 `/scan`、`/add-folder` 只写了 library.json
   * 而没刷新索引，导致「库里 14 篇、面板只显示 1 篇」。
   * 字段结构由 `tools/library_index.mjs` 的 `buildIndex()` 统一决定，
   * 与命令行 `tools/library.mjs export` 共用同一份实现，不会分叉。
   */
  async function refreshIndex() {
    const indexPath = join(libraryRoot, 'index.json');
    const modUrl = pathToFileURL(join(toolsRoot, 'library_index.mjs')).href;
    // 带查询串避免 Node 的模块缓存：改了 buildIndex 后无需重启即可生效
    const mod = await import(`${modUrl}?t=${Date.now()}`);
    const { db } = await loadDb();
    // 索引是展示缓存：从现有抽取稿/译稿即时补齐标题、年份和作者，
    // 让升级前的旧条目也能直接显示双语标题与完整侧栏名称。
    const metadataUrl = pathToFileURL(join(toolsRoot, 'paper_metadata.mjs')).href;
    const metadata = await import(`${metadataUrl}?t=${Date.now()}`);
    await Promise.all((db.papers ?? []).map(async (paper) => {
      const readMetadata = async (rel) => {
        if (!rel) return null;
        const abs = resolveInside(rel);
        if (abs === undefined || !existsSync(abs)) return null;
        try {
          return metadata.extractMetadataFromText(await readFile(abs, 'utf8'), {
            fallbackTitle: paper.title,
            slug: paper.slug,
          });
        } catch { return null; }
      };
      const [translated, extracted] = await Promise.all([
        readMetadata(paper.translation),
        readMetadata(paper.extracted),
      ]);
      const merged = metadata.mergeMetadata(translated, extracted);
      paper.titleZh ??= translated?.titleZh
        ?? (metadata.hasCjk(paper.title) ? paper.title : null)
        ?? (metadata.hasCjk(paper.slug) ? String(paper.slug).replace(/[-_\s]*(?:19|20)\d{2}$/, '') : null);
      const labeledTranslatedEnglish = translated?.evidence?.includes('labeled-title')
        ? translated.titleEn
        : null;
      paper.titleEn ??= labeledTranslatedEnglish ?? extracted?.titleEn
        ?? (!metadata.hasCjk(paper.title) ? paper.title : null);
      const slugYear = /(?:^|[-_\s])((?:19|20)\d{2})(?:$|[-_\s])/.exec(paper.slug)?.[1];
      const normalizedYear = Number(paper.year ?? slugYear ?? merged.year);
      paper.year = Number.isInteger(normalizedYear) && normalizedYear >= 1900 && normalizedYear <= 2099
        ? normalizedYear
        : null;
      paper.authors ??= translated?.authors ?? extracted?.authors ?? null;
    }));
    await writeFile(indexPath, `${JSON.stringify(mod.buildIndex(db), null, 2)}\n`, 'utf8');
    return (db.papers ?? []).length;
  }

  // ── 动作：隐藏 / 删除（文献与文件夹） ──

  /** 判断一篇文献是否属于某个分类路径（folder 或 category 匹配都算） */
  function paperInFolder(paper, folder) {
    if (!folder) return false;
    if (paper.folder === folder) return true;
    if (paper.category === folder) return true;
    // 支持「目录树前缀」：隐藏 `参考文献` 也能覆盖 `参考文献/子类`
    if (typeof paper.folder === 'string' && paper.folder.startsWith(`${folder}/`)) return true;
    return false;
  }

  /**
   * 文献在侧栏目录树里的「分组键」。
   *
   * 与客户端 `buildTree()` 保持一致：有 `folder` 用完整分类路径，否则退回
   * `category`（旧条目没有 folder 字段），都没有则归入「未分类」。
   * 手动排序与置顶都以这个键为作用域——**只在同一文件夹内调整**，不会打乱别的分类。
   */
  function paperGroupKey(paper) {
    const folder = typeof paper?.folder === 'string'
      ? paper.folder.trim().replace(/\\/g, '/').replace(/\/+/gu, '/')
      : '';
    if (folder !== '') return folder.replace(/\/+$/u, '');
    const category = typeof paper?.category === 'string' ? paper.category.trim() : '';
    return category !== '' ? category : '未分类';
  }

  /**
   * 手动排序 / 置顶。
   *
   * 两种动作：
   *   `{ action: 'order', folder, slugs: [...] }`
   *      把该文件夹内的文献按 slugs 的顺序重新编号（order = 0,10,20…）。
   *      客户端在「上移 / 下移」时把整组的新顺序发上来，服务端只做落盘，
   *      因此不需要在两处各实现一遍排序比较器。
   *   `{ action: 'pin'|'unpin', slug }`
   *      置顶 / 取消置顶。置顶的文献永远排在该文件夹最前面；
   *      新置顶的排在已有置顶项之前（order 取更小的值）。
   *
   * 与 `/mutate` 一样，只改 `library.json` 里的展示字段，不动任何文件；
   * 写完立刻 `refreshIndex()`，面板下一次读取就能看到新顺序。
   */
  async function handleArrange(body) {
    const action = String(body?.action ?? 'order');
    const { db, path: dbPath } = await loadDb();
    db.papers ??= [];

    if (action === 'pin' || action === 'unpin') {
      const slug = typeof body?.slug === 'string' ? body.slug.trim() : '';
      if (slug === '') throw Object.assign(new Error('缺少 slug'), { status: 400 });
      const paper = db.papers.find((p) => p.slug === slug);
      if (!paper) throw Object.assign(new Error(`文献库中没有 ${slug}`), { status: 404 });
      const folder = paperGroupKey(paper);

      if (action === 'pin') {
        // 排到「已置顶」小组的最前面；负数位次也便于以后继续往前插。
        const pinnedOrders = db.papers
          .filter((p) => p !== paper && p.pinned === true && paperGroupKey(p) === folder)
          .map((p) => (Number.isFinite(p.order) ? p.order : 0));
        paper.pinned = true;
        paper.pinnedAt = new Date().toISOString();
        paper.order = (pinnedOrders.length ? Math.min(...pinnedOrders) : 0) - 10;
      } else {
        paper.pinned = false;
        paper.pinnedAt = null;
      }

      await saveDb(db, dbPath);
      await refreshIndex();
      return { ok: true, action, slug, folder, paper: { slug, pinned: paper.pinned === true, order: paper.order } };
    }

    if (action === 'order') {
      const folder = typeof body?.folder === 'string'
        ? body.folder.trim().replace(/\\/g, '/').replace(/\/+/gu, '/').replace(/\/+$/u, '')
        : '';
      const slugs = Array.isArray(body?.slugs)
        ? body.slugs.filter((s) => typeof s === 'string' && s.trim() !== '').map((s) => s.trim())
        : [];
      if (folder === '') throw Object.assign(new Error('缺少 folder'), { status: 400 });
      if (slugs.length === 0) throw Object.assign(new Error('缺少 slugs（该文件夹的新顺序）'), { status: 400 });
      if (new Set(slugs).size !== slugs.length) {
        throw Object.assign(new Error('slugs 中存在重复项'), { status: 400 });
      }

      const inGroup = db.papers.filter((p) => paperGroupKey(p) === folder);
      if (inGroup.length === 0) {
        throw Object.assign(new Error(`没有属于「${folder}」的文献`), { status: 404 });
      }
      const bySlug = new Map(inGroup.map((p) => [p.slug, p]));
      const missing = slugs.filter((s) => !bySlug.has(s));
      if (missing.length > 0) {
        throw Object.assign(
          new Error(`这些文献不属于「${folder}」：${missing.slice(0, 3).join('、')}`),
          { status: 400 },
        );
      }

      // 只给本次提交的条目编号；没提交的（理论上不应出现）保持原位次。
      slugs.forEach((slug, index) => { bySlug.get(slug).order = index * 10; });
      await saveDb(db, dbPath);
      await refreshIndex();
      return { ok: true, action, folder, ordered: slugs.length };
    }

    throw Object.assign(new Error(`未知 action：${action}（应为 order/pin/unpin）`), { status: 400 });
  }

  /** 把一个 PDF 移进库内回收目录（保留相对层级），返回回收后的相对路径 */
  async function moveToTrash(relSource) {
    if (!relSource) return null;
    const srcAbs = resolveInside(relSource);
    if (srcAbs === undefined || !existsSync(srcAbs)) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destAbs = resolve(join(libraryRoot, 'trash', stamp, basename(srcAbs)));
    if (!destAbs.startsWith(resolve(join(libraryRoot, 'trash')) + sep)) return null;
    await mkdir(dirname(destAbs), { recursive: true });
    await rename(srcAbs, destAbs);
    // 顺带清掉 paper 目录里可能留下的空文件夹
    try {
      const parent = dirname(srcAbs);
      if (parent.startsWith(papersRoot + sep) && (await readdir(parent)).length === 0) {
        await rmdir(parent);
      }
    } catch { /* 空目录清理失败无所谓 */ }
    return relative(workspaceRoot, destAbs).replace(/\\/g, '/');
  }

  /**
   * 隐藏 / 取消隐藏 / 删除 文献；也支持按文件夹批量。
   *
   * 幂等性：重复隐藏同一篇不会报错。
   * 删除是**软删除**——PDF 移到 `<库>/trash/<时间戳>/`，条目从库里移除，
   * 这样误删还能找回（比直接 unlink 安全得多）。
   *
   * @param body - `{ action: 'hide'|'unhide'|'delete', slug?, folder? }`
   */
  async function handleMutate(body) {
    const action = String(body.action ?? '');
    const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
    const folder = typeof body.folder === 'string' ? body.folder.trim() : '';
    if (!['hide', 'unhide', 'delete'].includes(action)) {
      throw Object.assign(new Error(`未知 action：${action}（应为 hide/unhide/delete）`), { status: 400 });
    }
    if (slug === '' && folder === '') {
      throw Object.assign(new Error('需要给 slug 或 folder'), { status: 400 });
    }

    const { db, path: dbPath } = await loadDb();
    db.papers ??= [];

    const targets = folder !== ''
      ? db.papers.filter((p) => paperInFolder(p, folder))
      : db.papers.filter((p) => p.slug === slug);

    if (targets.length === 0) {
      throw Object.assign(new Error(folder ? `没有属于「${folder}」的文献` : `文献库中没有 ${slug}`), { status: 404 });
    }

    const affected = [];

    if (action === 'hide' || action === 'unhide') {
      for (const p of targets) {
        p.hidden = action === 'hide';
        p.hiddenAt = action === 'hide' ? new Date().toISOString() : null;
        affected.push(p.slug);
      }
      await saveDb(db, dbPath);
    } else {
      // 删除：先移文件，成功后再从库里移除，避免「库里没了但文件还在」的不一致
      const trashed = [];
      for (const p of targets) {
        const moved = await moveToTrash(p.source);
        trashed.push({ slug: p.slug, from: p.source, to: moved });
        affected.push(p.slug);
      }
      db.papers = db.papers.filter((p) => !affected.includes(p.slug));
      // 分类里若已无文献，顺手清掉该分类（避免目录树出现空分类）
      const stillUsed = new Set(db.papers.map((p) => p.category));
      db.categories = (db.categories ?? []).filter((c) => stillUsed.has(c) || DEFAULT_KEEP_CATEGORIES.includes(c));
      await saveDb(db, dbPath);
      await refreshIndex();
      return { ok: true, action, removed: affected, trashed, folder: folder || null };
    }

    await refreshIndex();
    return { ok: true, action, affected, folder: folder || null };
  }

  /**
   * 列出本插件创建的翻译会话及其进度。
   *
   * 数据源是 DSH 的会话日志（`~/.dsh/sessions/<工作区>/<id>/session.v4.jsonl.zstd`）。
   * 走文件而不是内存：重启后仍在；也顺带覆盖了「用户自己在别处点的翻译」。
   * 只用 `sess-` 前缀识别本插件创建的会话，避免把用户正常对话当成翻译任务。
   */
  async function handleSessions() {
    const sessionsRoot = sessionsRootDir();
    const dir = join(sessionsRoot, encodeWorkspaceToDirName(workspaceRoot));
    if (!existsSync(dir)) return { sessions: [], dir, hint: '会话目录不存在' };

    let names = [];
    try { names = await readdir(dir); } catch (err) {
      return { sessions: [], dir, hint: `读取失败：${err?.message ?? err}` };
    }
    const ids = names.filter(isPluginSessionId);

    // 并发读，但限制一下数量避免一次性开太多文件
    const out = [];
    const BATCH = 8;
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      const got = await Promise.all(chunk.map((id) => readSessionProgress(sessionsRoot, workspaceRoot, id)));
      out.push(...got);
    }
    // 最近的排前面
    out.sort((a, b) => String(b.mtime ?? '').localeCompare(String(a.mtime ?? '')));
    return { sessions: out, dir, total: out.length };
  }

  // ── 登记：把一批 PDF 写进文献库（被 /scan 与 /add-folder 共用） ──

  /**
   * 把已定位的 PDF 列表登记进库。
   * @param pdfs - `{ absPath, relToRoot: string[], file }[]`；relToRoot 是**相对文献库
   *               papers 根**的子文件夹层级，它决定分类路径。
   * @param extra - 附加到每条记录上的字段（例如来自哪个源文件夹）。
   * @returns `{ added, skipped }`
   */
  async function registerPdfs(pdfs, extra = {}) {
    const { db, path: dbPath } = await loadDb();
    db.papers ??= [];
    db.categories ??= [];

    const known = new Set(db.papers.map((p) => p.slug));
    const added = [];
    const skipped = [];

    for (const p of pdfs) {
      let slug = slugify(p.file);
      if (known.has(slug)) { skipped.push(slug); continue; }

      // slug 冲突（同名不同目录）时加后缀，而不是静默丢弃
      let n = 2;
      const baseSlug = slug;
      while (known.has(slug)) { slug = `${baseSlug}-${n}`; n += 1; }

      const category = p.relToRoot.length ? p.relToRoot[0] : '未分类';
      db.papers.push({
        slug,
        title: basename(p.file, extname(p.file)),
        year: null,
        authors: null,
        category,
        tags: p.relToRoot.slice(1),
        folder: p.relToRoot.join('/'),
        status: 'extracted',
        source: relative(workspaceRoot, p.absPath).replace(/\\/g, '/'),
        extracted: null,
        // 译稿路径**固定在库内**，不跟随 PDF 的原始位置
        translation: null,
        translationPath: `${libraryDir}/translations/${slug}/${slug}.md`,
        translatedAt: null,
        addedAt: new Date().toISOString(),
        note: null,
        journal: {},
        ...extra,
      });
      if (!db.categories.includes(category)) db.categories.push(category);
      known.add(slug);
      added.push(slug);
    }

    if (added.length) await saveDb(db, dbPath);
    return { added, skipped };
  }
  // ── 动作：扫描库内目录，按子文件夹分类登记 ──

  async function handleScan(body) {
    const relDir = typeof body.dir === 'string' && body.dir.trim() !== ''
      ? body.dir
      : `${libraryDir}/${papersDir}`;
    const abs = resolveInside(relDir);
    if (abs === undefined) throw Object.assign(new Error('目录越权'), { status: 403 });
    if (!existsSync(abs)) throw Object.assign(new Error(`目录不存在：${relDir}`), { status: 404 });

    const pdfs = await findPdfs(abs);
    const { added, skipped } = await registerPdfs(pdfs);
    const total = await refreshIndex();   // 立刻刷新面板读的索引
    return { scanned: pdfs.length, added, skipped, dir: relDir, total };
  }

  /**
   * 扫描某个**库内分类文件夹对应的原始外部文件夹**，把新增 PDF 复制进该分类。
   *
   * 来源记录：
   *   - 新导入会在 library.json 的 folderSources[顶层分类] 记录源路径；
   *   - 旧库没有 folderSources 时，从该分类已有文献的 importedFrom 推断。
   * 选中嵌套分类时，顶层源路径 + 嵌套后缀就是真正要扫描的目录。
   */
  async function handleScanSource(body) {
    const raw = String(body.folder ?? '').replace(/\\/g, '/').trim();
    const parts = raw.split('/').filter((s) => s !== '' && s !== '.' && s !== '..');
    if (parts.length === 0) throw Object.assign(new Error('缺少要扫描的分类文件夹'), { status: 400 });
    const folder = parts.join('/');
    const folderAbs = resolve(join(papersRoot, ...parts));
    if (folderAbs !== papersRoot && !folderAbs.startsWith(papersRoot + sep)) {
      throw Object.assign(new Error('分类路径越权'), { status: 403 });
    }

    const { db } = await loadDb();
    const top = parts[0];
    let sourceRoot = db.folderSources?.[top];
    if (!sourceRoot) {
      const under = (db.papers ?? []).filter((p) => typeof p.folder === 'string'
        && (p.folder === folder || p.folder.startsWith(`${folder}/`)));
      const imported = [...new Set(under.map((p) => p.importedFrom).filter(Boolean))];
      if (imported.length > 1) {
        throw Object.assign(new Error('这个文件夹有多个导入来源，无法自动确定要扫描哪个'), { status: 409 });
      }
      if (imported.length === 1) sourceRoot = imported[0];
    }
    if (!sourceRoot) {
      throw Object.assign(new Error('这个文件夹没有记录导入来源；请用「＋ 导入」重新导入一次'), { status: 404 });
    }

    const source = parts.length > 1 ? join(sourceRoot, ...parts.slice(1)) : sourceRoot;
    if (!existsSync(source)) {
      throw Object.assign(new Error(`原始文件夹不存在：${source}`), { status: 404 });
    }
    if (!(await stat(source)).isDirectory()) {
      throw Object.assign(new Error(`原始路径不是文件夹：${source}`), { status: 400 });
    }

    const pdfs = await findPdfs(source);
    const targets = [];
    let copied = 0;
    for (const p of pdfs) {
      const relParts = [...parts, ...p.relToRoot];
      const destAbs = resolve(join(papersRoot, ...relParts, p.file));
      if (!destAbs.startsWith(papersRoot + sep)) continue;
      await mkdir(dirname(destAbs), { recursive: true });
      if (!existsSync(destAbs)) {
        await copyFile(p.absPath, destAbs);
        copied += 1;
      }
      targets.push({ absPath: destAbs, relToRoot: relParts, file: p.file });
    }

    const { added, skipped } = await registerPdfs(targets, { importedFrom: sourceRoot });
    const total = await refreshIndex();
    return {
      folder, source, scanned: pdfs.length, copied,
      added, skipped, total,
    };
  }

  // ── 动作：添加外部文件夹（复制进库，保留子目录层级） ──

  /**
   * 把**工作区之外**任意文件夹里的 PDF 收进文献库。
   *
   * 为什么是「复制」而不是「就地引用」：
   *   1. 库外的文件无法通过 `/file` 路由读取（那条路由限制在库内，是有意的安全边界）；
   *   2. 文献库因此保持自包含——备份/迁移只搬 `library/` 就够；
   *   3. 顺带满足「保留原子文件夹结构」：复制时原样重建目录层级，分类即目录树。
   * 代价是磁盘上会多一份副本（论文 PDF 通常几百 KB，可接受）。
   *
   * @param body - `{ dir: 源文件夹绝对路径, group?: 顶层分组名, dryRun?: boolean }`
   */
  async function handleAddFolder(body) {
    const dir = typeof body.dir === 'string' ? body.dir.trim() : '';
    if (dir === '') throw Object.assign(new Error('缺少 dir（源文件夹路径）'), { status: 400 });
    const srcRoot = resolve(dir);
    if (!existsSync(srcRoot)) throw Object.assign(new Error(`源文件夹不存在：${srcRoot}`), { status: 404 });
    if (!(await stat(srcRoot)).isDirectory()) throw Object.assign(new Error('源路径不是文件夹'), { status: 400 });

    // 顶层分组名：默认取源文件夹名，用于在库内区分不同来源
    const rawGroup = typeof body.group === 'string' && body.group.trim() !== ''
      ? body.group.trim()
      : basename(srcRoot);
    const group = slugify(rawGroup) || '外部导入';

    const destRoot = resolve(join(papersRoot, group));
    // 目标必须在库内（group 是 sanitize 过的，这里再确认一次，防目录穿越）
    if (!(destRoot === papersRoot || destRoot.startsWith(papersRoot + sep))) {
      throw Object.assign(new Error('目标路径越权'), { status: 403 });
    }

    const found = await findPdfs(srcRoot);
    if (body.dryRun === true) {
      return { dryRun: true, dir: srcRoot, group, total: found.length, destRoot: relative(workspaceRoot, destRoot).replace(/\\/g, '/') };
    }

    // 复制（保留子目录层级）
    let copied = 0;
    const targets = [];
    for (const p of found) {
      const relParts = [group, ...p.relToRoot];
      const destAbsGrouped = resolve(join(papersRoot, group, ...p.relToRoot, p.file));
      if (!destAbsGrouped.startsWith(papersRoot + sep)) continue;   // 防御
      await mkdir(dirname(destAbsGrouped), { recursive: true });
      await copyFile(p.absPath, destAbsGrouped);
      copied += 1;
      targets.push({ absPath: destAbsGrouped, relToRoot: relParts, file: p.file });
    }

    const { added, skipped } = await registerPdfs(targets, { importedFrom: srcRoot });
    // 记住“顶层分类 ← 原始文件夹”的映射，后续「扫描此文件夹」用它找新增 PDF
    const { db: freshDb, path: freshDbPath } = await loadDb();
    freshDb.folderSources ??= {};
    freshDb.folderSources[group] = srcRoot;
    await saveDb(freshDb, freshDbPath);
    const total = await refreshIndex();   // 立刻刷新面板读的索引
    return {
      ok: true,
      dir: srcRoot,
      group,
      dest: relative(workspaceRoot, destRoot).replace(/\\/g, '/'),
      total: found.length,
      copied,
      added,
      skipped,
      libraryTotal: total,
    };
  }

  // ── 动作：保存译文（面板内编辑） ──

  /**
   * 把编辑器里的内容写回译稿文件。
   *
   * 安全约束（重要）：DSH 的 web 服务器不带鉴权，任何本机进程都能调到这些路由。
   * 所以这里**只允许写 `<库>/translations/` 之下的 `.md`**，其余一律拒绝。
   * 另外写入前会比对磁盘内容：若文件已被别处改动，返回 409 让界面提示，避免静默覆盖。
   */
  async function handleSaveTranslation(body) {
    const slug = typeof body.slug === 'string' ? body.slug : '';
    const content = typeof body.content === 'string' ? body.content : null;
    if (slug === '') throw Object.assign(new Error('缺少 slug'), { status: 400 });
    if (content === null) throw Object.assign(new Error('缺少 content'), { status: 400 });

    const { db } = await loadDb();
    const paper = (db.papers ?? []).find((p) => p.slug === slug);
    if (!paper) throw Object.assign(new Error(`文献库中没有 ${slug}`), { status: 404 });

    const rel = paper.translation
      || `${libraryDir}/translations/${slug}/${slug}.md`;
    const abs = resolveInside(rel);
    if (abs === undefined) throw Object.assign(new Error('路径越权'), { status: 403 });

    // 只允许写译稿目录下的 .md
    const translationsRoot = resolve(join(libraryRoot, 'translations'));
    if (!abs.startsWith(translationsRoot + sep)) {
      throw Object.assign(new Error('只允许写入 translations/ 目录下的文件'), { status: 403 });
    }
    if (extname(abs).toLowerCase() !== '.md') {
      throw Object.assign(new Error('只允许写入 .md 文件'), { status: 403 });
    }

    // 乐观并发：磁盘内容与「界面加载时的内容」不一致时提示而不是覆盖
    if (typeof body.baseContent === 'string' && existsSync(abs)) {
      const current = await readFile(abs, 'utf8');
      if (current !== body.baseContent) {
        throw Object.assign(new Error('文件已在别处被修改，未保存。请刷新后重试'), { status: 409 });
      }
    }

    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');

    // 登记，并从刚保存的译稿更新双语标题等本地元数据。
    let dbChanged = false;
    if (!paper.translation) { paper.translation = rel.replace(/\\/g, '/'); dbChanged = true; }
    if (paper.status !== 'translated') { paper.status = 'translated'; dbChanged = true; }
    const metadata = await import(
      `${pathToFileURL(join(toolsRoot, 'paper_metadata.mjs')).href}?t=${Date.now()}`
    );
    const local = metadata.extractMetadataFromText(content, {
      fallbackTitle: paper.title,
      slug: paper.slug,
    });
    if (local.titleZh && local.titleZh !== paper.titleZh) {
      paper.titleZh = local.titleZh;
      if (!paper.title || paper.title === paper.slug) paper.title = local.titleZh;
      dbChanged = true;
    }
    if (local.titleEn && local.evidence?.includes('labeled-title') && !paper.titleEn) {
      paper.titleEn = local.titleEn;
      dbChanged = true;
    }
    if (local.authors && !paper.authors) { paper.authors = local.authors; dbChanged = true; }
    if (local.year && !paper.year) { paper.year = local.year; dbChanged = true; }
    if (dbChanged) {
      paper.translatedAt = paper.translatedAt ?? new Date().toISOString();
      await saveDb(db, join(libraryRoot, 'library.json'));
    }
    await refreshIndex();   // 内容里的标题也可能变了，展示索引始终跟进。

    return { ok: true, path: rel.replace(/\\/g, '/'), bytes: Buffer.byteLength(content) };
  }

  // ── 动作：更新期刊信息等元数据 ──

  /** 允许从面板编辑的字段；其余字段一律忽略，避免界面误改内部状态 */
  const EDITABLE_JOURNAL_KEYS = [
    'name', 'abbr', 'doi', 'impactFactor', 'jcrQuartile',
    'casQuartile', 'isTop', 'issn', 'publisher',
  ];
  const EDITABLE_PAPER_KEYS = ['title', 'titleZh', 'titleEn', 'year', 'authors', 'category', 'note'];

  async function handleUpdateMetadata(body) {
    const slug = typeof body.slug === 'string' ? body.slug : '';
    if (slug === '') throw Object.assign(new Error('缺少 slug'), { status: 400 });

    const { db, path: dbPath } = await loadDb();
    const paper = (db.papers ?? []).find((p) => p.slug === slug);
    if (!paper) throw Object.assign(new Error(`文献库中没有 ${slug}`), { status: 404 });

    const changed = [];

    if (body.paper && typeof body.paper === 'object') {
      for (const k of EDITABLE_PAPER_KEYS) {
        if (k in body.paper) {
          const v = body.paper[k];
          paper[k] = (v === '' || v === null || v === undefined) ? null : v;
          changed.push(k);
        }
      }
    }

    if (body.journal && typeof body.journal === 'object') {
      paper.journal ??= {};
      for (const k of EDITABLE_JOURNAL_KEYS) {
        if (k in body.journal) {
          let v = body.journal[k];
          if (v === '' || v === null || v === undefined) v = null;
          // 影响因子按数字存，方便排序/导出
          if (k === 'impactFactor' && v !== null) {
            const n = Number(v);
            v = Number.isFinite(n) ? n : null;
          }
          if (k === 'isTop') v = (v === true || v === 'true');
          paper.journal[k] = v;
          changed.push(`journal.${k}`);
        }
      }
      paper.journal.updatedAt = new Date().toISOString();
    }

    await saveDb(db, dbPath);
    await refreshIndex();   // 期刊信息也要出现在索引里（顶部信息条读的是索引）
    return { ok: true, changed, paper };
  }

  // ── 动作：按 ablesci（科研通）补全期刊信息 ──

  /**
   * 查一篇文献的期刊信息并写回。
   *
   * 查的是科研通（ablesci.com）——实测其详情页数据是服务端渲染的，
   * 且搜索参数为 `keywords`（见 tools/ablesci.mjs 的说明）。
   *
   * 为什么做成**一次一篇**而不是一次性批量阻塞：每次查询要发 2 个 HTTP 请求
   * （搜索 + 详情），批量 39 篇就是 78 个请求，必须限速；而且用户需要看到进度。
   * 所以批量由客户端逐篇调用本端点（中间加延时），单篇失败不影响其它。
   *
   * @param body - `{ slug, name?, issn?, doi?, dryRun? }`
   */
  async function handleFillJournal(body) {
    const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
    if (slug === '') throw Object.assign(new Error('缺少 slug'), { status: 400 });

    const { db, path: dbPath } = await loadDb();
    const paper = (db.papers ?? []).find((p) => p.slug === slug);
    if (!paper) throw Object.assign(new Error(`文献库中没有 ${slug}`), { status: 404 });

    const metadataMod = await import(
      `${pathToFileURL(join(toolsRoot, 'paper_metadata.mjs')).href}?t=${Date.now()}`
    );
    const localParts = [];
    let translatedLocal = null;
    let extractedLocal = null;
    let extractedOnDemand = null;
    let extractionWarning = null;
    // 英文抽取稿优先提供英文标题；中文译稿通常提供更清晰的作者/期刊/DOI 标签。
    for (const [kind, rel] of [['extracted', paper.extracted], ['translated', paper.translation]]) {
      if (!rel) continue;
      const abs = resolveInside(rel);
      if (abs === undefined || !existsSync(abs)) continue;
      try {
        const content = await readFile(abs, 'utf8');
        const found = metadataMod.extractMetadataFromText(content, {
          fallbackTitle: paper.title,
          slug: paper.slug,
        });
        localParts.push(found);
        if (kind === 'translated') translatedLocal = found;
        else extractedLocal = found;
      } catch { /* 单个辅助文本损坏时继续尝试其它来源 */ }
    }
    // 只有 PDF、还没做过文本抽取时，单篇/批量自动补全会先抽取首页文本。
    // dryRun 保持无副作用，不会临时生成文件。
    if (localParts.length === 0 && body.dryRun !== true && paper.source) {
      const pdfAbs = resolveInside(paper.source);
      if (pdfAbs !== undefined && existsSync(pdfAbs)) {
        try {
          const extracted = await extractPdfText(pdfAbs, paper.slug, undefined);
          extractedOnDemand = relative(workspaceRoot, extracted.mdPath).replace(/\\/g, '/');
          extractedLocal = metadataMod.extractMetadataFromText(extracted.md, {
            fallbackTitle: paper.title,
            slug: paper.slug,
          });
          localParts.push(extractedLocal);
        } catch (error) {
          extractionWarning = `PDF 文本抽取失败：${error?.message ?? error}`;
        }
      }
    }
    const local = metadataMod.mergeMetadata(...localParts);
    const requestedDoi = metadataMod.normalizeDoi(body.doi)
      ?? metadataMod.normalizeDoi(paper.journal?.doi)
      ?? metadataMod.normalizeDoi(paper.doi)
      ?? local.doi;

    let crossref = null;
    let crossrefWarning = null;
    if (requestedDoi) {
      const found = await metadataMod.lookupCrossrefByDoi(requestedDoi);
      if (found.ok) crossref = found.info;
      else crossrefWarning = found.error;
    } else if (local.titleEn || local.title) {
      const found = await metadataMod.lookupCrossrefByTitle(local.titleEn || local.title);
      if (found.ok) crossref = found.info;
      else crossrefWarning = found.error;
    }

    const explicitName = typeof body.name === 'string' ? body.name.trim() : '';
    const explicitIssn = typeof body.issn === 'string' ? body.issn.trim() : '';
    // 可信度顺序：用户本次明确输入 > Crossref DOI/标题记录 > 文档标签 > 旧库值。
    // 这样能纠正过去由科研通模糊搜索写入的错误刊名。
    const name = explicitName || crossref?.journal || local.journal || (paper.journal?.name || '').trim();
    const issn = explicitIssn || crossref?.issn || local.issn || (paper.journal?.issn || '').trim();
    const doi = requestedDoi || crossref?.doi || null;

    const detected = {
      title: crossref?.title || local.titleEn || local.title || null,
      titleEn: crossref?.titleEn || crossref?.title || local.titleEn || null,
      titleZh: translatedLocal?.titleZh || local.titleZh || paper.titleZh
        || (metadataMod.hasCjk(paper.title) ? paper.title : null),
      authors: crossref?.authors || local.authors || null,
      year: crossref?.year || local.year || null,
      name: crossref?.journal || local.journal || null,
      abbr: crossref?.journalAbbr || null,
      issn: crossref?.issn || local.issn || null,
      publisher: crossref?.publisher || null,
      doi,
      metadataSource: crossref ? 'Crossref + 文档提取' : '文档提取',
      crossrefUrl: crossref?.url || null,
      evidence: local.evidence ?? [],
    };

    const ablesciMod = await import(`${pathToFileURL(join(toolsRoot, 'ablesci.mjs')).href}?t=${Date.now()}`);
    const journalResult = (name || issn)
      ? await ablesciMod.lookupJournal({ name, issn })
      : { ok: false, error: '未能从文档识别期刊名、ISSN 或 DOI', candidates: [] };
    const journalInfo = journalResult.ok ? journalResult.info : null;
    // 只有精确刊名或 ISSN 对得上才接受影响因子/分区，杜绝模糊搜索写错刊。
    const journalTrusted = journalInfo?.matchedExactly === true || journalInfo?.issnMatched === true;
    const info = {
      ...detected,
      ...(journalTrusted ? journalInfo : {}),
      doi,
      title: detected.title,
      titleEn: detected.titleEn,
      titleZh: detected.titleZh,
      authors: detected.authors,
      year: detected.year,
      name: journalTrusted ? (journalInfo.name || detected.name || name) : (detected.name || name || null),
      abbr: journalTrusted ? (journalInfo.abbr || detected.abbr) : detected.abbr,
      issn: journalTrusted ? (journalInfo.issn || detected.issn || issn) : (detected.issn || issn || null),
      publisher: journalTrusted ? (journalInfo.publisher || detected.publisher) : detected.publisher,
      matchedExactly: journalTrusted,
      matchedName: journalInfo?.matchedName ?? null,
      sourceUrl: journalTrusted ? journalInfo.sourceUrl : (crossref?.url || null),
      warning: !journalResult.ok
        ? [journalResult.error, crossrefWarning, extractionWarning].filter(Boolean).join('；')
        : (!journalTrusted ? `科研通候选「${journalInfo?.matchedName ?? name}」未通过精确刊名/ISSN 校验，未写入影响因子和分区` : crossrefWarning),
    };

    const hasDetectedMetadata = Boolean(
      info.doi || info.name || info.titleEn || info.titleZh || info.title || info.authors || info.year,
    );
    if (!hasDetectedMetadata) {
      return {
        ok: false,
        slug,
        error: journalResult.error || crossrefWarning || '没有识别到论文元数据',
        hint: '请确认已经生成译稿或抽取文本；也可以在「编辑期刊信息」里手工填写 DOI 或期刊名',
        candidates: journalResult.candidates ?? [],
      };
    }
    if (body.dryRun === true) {
      return { ok: true, slug, dryRun: true, partial: !journalTrusted, info };
    }

    // 只有非空值才覆盖，避免把用户手工字段清掉。
    const j = paper.journal ??= {};
    const assign = (key, value) => {
      if (value === null || value === undefined || value === '') return false;
      j[key] = value;
      return true;
    };
    const changed = [];
    if (extractedOnDemand && paper.extracted !== extractedOnDemand) {
      paper.extracted = extractedOnDemand;
      changed.push('extracted');
    }
    const placeholderTitle = !paper.title || paper.title === paper.slug;
    if (info.titleEn && paper.titleEn !== info.titleEn) { paper.titleEn = info.titleEn; changed.push('titleEn'); }
    if (info.titleZh && paper.titleZh !== info.titleZh) { paper.titleZh = info.titleZh; changed.push('titleZh'); }
    if (placeholderTitle && (info.titleZh || info.titleEn)) {
      paper.title = info.titleZh || info.titleEn;
      changed.push('title');
    }
    if (!paper.authors && info.authors) { paper.authors = info.authors; changed.push('authors'); }
    if (!paper.year && info.year) { paper.year = info.year; changed.push('year'); }
    if (assign('doi', info.doi)) changed.push('doi');
    if (assign('name', info.name)) changed.push('name');
    if (assign('abbr', info.abbr)) changed.push('abbr');
    if (assign('issn', info.issn)) changed.push('issn');
    if (assign('impactFactor', info.impactFactor)) changed.push('impactFactor');
    if (assign('jcrQuartile', info.jcrQuartile)) changed.push('jcrQuartile');
    if (journalTrusted && assign('jcrCategory', info.jcrCategory)) changed.push('jcrCategory');
    if (assign('casQuartile', info.casQuartile)) changed.push('casQuartile');
    if (assign('casMajor', info.casMajor)) changed.push('casMajor');
    if (assign('publisher', info.publisher)) changed.push('publisher');
    if (assign('country', info.country)) changed.push('country');
    if (typeof info.isTop === 'boolean') { j.isTop = info.isTop; changed.push('isTop'); }
    // 自动识别的来源与证据也保存，方便以后判断字段能否自动覆盖。
    j.metadata = {
      source: info.metadataSource,
      crossrefUrl: info.crossrefUrl,
      evidence: info.evidence,
      detectedAt: new Date().toISOString(),
      warning: info.warning ?? null,
    };
    changed.push('metadata');
    if (journalTrusted) j.ablesci = {
      impactHistory: info.impactHistory ?? [],
      selfCiteRate: info.selfCiteRate ?? null,
      hIndex: info.hIndex ?? null,
      scope: info.scope ?? null,
      frequency: info.frequency ?? null,
      foundedYear: info.foundedYear ?? null,
      articlesPerYear: info.articlesPerYear ?? null,
      goldOaRatio: info.goldOaRatio ?? null,
      casYear: info.casYear ?? null,
      indexedIn: info.indexedIn ?? null,
      warningList: info.warningList ?? null,
      sourceUrl: info.sourceUrl ?? null,
      fetchedAt: new Date().toISOString(),
      matchedName: info.matchedName ?? null,
      // 名字没精确匹配上时如实标注，提示用户核对
      matchedExactly: info.matchedExactly === true,
    };
    j.updatedAt = new Date().toISOString();
    if (journalTrusted) changed.push('ablesci');

    await saveDb(db, dbPath);
    await refreshIndex();
    ctx.logger?.info?.(`literature-library: 已补全 ${slug} 的期刊信息（${changed.length} 个字段，来源 ${info.sourceUrl}）`);

    return {
      ok: true,
      slug,
      changed,
      partial: !journalTrusted,
      info,
    };
  }

  // ── 动作：直连 DeepSeek API 翻译（默认路径，可控、进度可见） ──

  /**
   * 用工作区里的 `tools/extract_pdf.mjs` 抽取 PDF 文本。
   *
   * 定位说明：这个函数定义在 `apply()` **内部**——它要用 `libraryRoot` /
   * `workspaceRoot`，那两个是 apply 的局部变量。第一版放在模块层，
   * 任务启动后才报 `libraryRoot is not defined`（比较隐蔽，值得记一笔）。
   *
   * 关于沙箱：子进程用 `stdio: 'ignore'`，不经过管道——
   * 受限环境下「父进程读子进程管道」会被拒绝（EPERM），
   * 而我们只需要它写到磁盘上的文件，不需要它的屏幕输出。
   */
  async function extractPdfText(pdfAbs, slug, signal) {
    const outDir = join(libraryRoot, 'extracted', slug);
    const mdPath = join(outDir, `${slug}.md`);
    const script = join(toolsRoot, 'extract_pdf.mjs');

    if (!existsSync(script)) throw new Error(`找不到抽取脚本：${script}`);
    await mkdir(outDir, { recursive: true });

    const { spawn } = await import('node:child_process');
    await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, [
        script, pdfAbs,
        '--out', join(libraryRoot, 'extracted'),
        '--name', slug,
        '--no-json',
      ], { stdio: 'ignore', cwd: workspaceRoot });

      const onAbort = () => { try { child.kill(); } catch { /* ignore */ } };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      child.on('error', (err) => rejectPromise(new Error(`抽取进程启动失败：${err.message}`)));
      child.on('close', (code) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (code !== 0) rejectPromise(new Error(`抽取失败（退出码 ${code}）`));
        else resolvePromise();
      });
    });

    if (!existsSync(mdPath)) throw new Error(`抽取脚本没有产出 ${mdPath}`);
    const md = await readFile(mdPath, 'utf8');
    if (md.trim() === '') throw new Error('抽取结果为空，无法翻译');
    return {
      mdPath,
      md,
      warning: '文本由 PDF 抽取而来；双栏版式的首页/摘要区可能仍有交织，请对照原文核对。',
    };
  }

  /**
   * 启动一次翻译任务。**立即返回** jobId，真正的翻译在后台跑，进度用
   * `GET /translate-job?id=` 查。
   *
   * 为什么不等着翻完再返回：一篇论文要分十几块、每块几十秒，
   * 同步等待必然超时；而且用户需要看到进度。
   *
   * @param body - `{ slug, model?, maxTokens?, force? }`
   */
  async function handleTranslateJob(body) {
    const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
    if (slug === '') throw Object.assign(new Error('缺少 slug'), { status: 400 });

    const { db } = await loadDb();
    const paper = (db.papers ?? []).find((p) => p.slug === slug);
    if (!paper) throw Object.assign(new Error(`文献库中没有 ${slug}`), { status: 404 });
    if (!paper.source) throw Object.assign(new Error(`${slug} 没有登记原始 PDF`), { status: 400 });

    // 同一篇已经有任务在跑 → 直接返回那个任务，避免重复烧 token
    for (const [id, job] of translateJobs) {
      if (job.slug === slug && (job.phase === 'running' || job.phase === 'queued')) {
        return { ok: true, reused: true, ...publicJob(id, job) };
      }
    }

    const stamp = Date.now();
    const tools = await import(`${pathToFileURL(join(toolsRoot, 'deepseek_translate.mjs')).href}?t=${stamp}`);
    const pipeline = await import(`${pathToFileURL(join(toolsRoot, 'translation_pipeline.mjs')).href}?t=${stamp}`);
    const { key, source: keySource } = await tools.resolveApiKey(config);
    if (!key) {
      throw Object.assign(
        new Error('没有可用的 DeepSeek API key。请设置环境变量 DEEPSEEK_API_KEY，'
          + '或确认 ~/.dsh/.credentials.yaml 里有 DEEPSEEK_API_KEY，或在插件配置里给 apiKey。'),
        { status: 501 },
      );
    }

    const jobId = newJobId();
    const now = new Date().toISOString();
    const schedule = body.schedule === 'offpeak' ? 'offpeak' : 'now';
    const requestedStart = schedule === 'offpeak'
      ? pipeline.nextOffpeakTime(new Date())
      : new Date();
    const job = {
      id: jobId,
      slug,
      title: paper.title ?? slug,
      phase: 'queued',
      stage: requestedStart.getTime() > Date.now() + 1000
        ? `等待闲时（${requestedStart.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}）`
        : '等待队列',
      chunkIndex: 0,
      chunkTotal: 0,
      startedAt: now,
      actualStartedAt: null,
      updatedAt: now,
      finishedAt: null,
      error: null,
      warning: null,
      outputPath: paper.translation
        || paper.translationPath
        || `${libraryDir}/translations/${slug}/${slug}.md`,
      model: typeof body.model === 'string' && body.model.trim() !== '' ? body.model.trim() : (config.model || tools.DEFAULT_MODEL),
      maxTokens: Number.isFinite(body.maxTokens) && body.maxTokens > 0
        ? Math.floor(body.maxTokens)
        : (Number.isFinite(Number(config.maxTokens)) && Number(config.maxTokens) > 0
          ? Math.floor(Number(config.maxTokens)) : 32000),
      reasoningEffort: ['none', 'low', 'high', 'max'].includes(body.reasoningEffort)
        ? body.reasoningEffort : 'none',
      qualityModel: typeof body.qualityModel === 'string' && body.qualityModel.trim() !== ''
        ? body.qualityModel.trim() : (config.qualityModel || 'deepseek-v4-pro'),
      schedule,
      notBefore: requestedStart.toISOString(),
      pricingPeriod: pipeline.isPeakShanghai(requestedStart) ? 'peak' : 'offpeak',
      keySource,
      charsIn: 0,
      charsOut: 0,
      usages: [],
      usage: {
        inputTokens: 0, outputTokens: 0, cacheHitTokens: 0,
        cacheMissTokens: 0, reasoningTokens: 0,
      },
      estimatedCostCny: 0,
      localCacheHits: 0,
      apiChunks: 0,
      retryCount: 0,
      validationFailures: 0,
      droppedFormulas: 0,
      budgetRetries: 0,
      upgradedChunks: 0,
      log: [],
    };
    translateJobs.set(jobId, job);
    pruneJobs();

    // 统一进队列，不在请求处理线程中等待整篇论文完成。
    enqueueTranslation({
      notBefore: requestedStart.getTime(),
      execute: () => runTranslateJob(job, paper, tools, pipeline, key, body),
      onError: (err) => {
        job.phase = 'failed';
        job.error = String(err?.message ?? err);
        job.stage = '失败（已保存完成的分块，下次可续传）';
        job.finishedAt = new Date().toISOString();
        job.updatedAt = job.finishedAt;
        ctx.logger?.warn?.(`literature-library: 翻译任务 ${jobId} 失败 — ${job.error}`);
      },
    });

    return { ok: true, reused: false, ...publicJob(jobId, job) };
  }

  /** 给客户端的任务视图（不暴露 key 等敏感字段） */
  function publicJob(id, job) {
    return {
      jobId: id,
      slug: job.slug,
      title: job.title,
      phase: job.phase,
      stage: job.stage,
      chunkIndex: job.chunkIndex,
      chunkTotal: job.chunkTotal,
      percent: job.chunkTotal > 0
        ? Math.round((job.chunkIndex / job.chunkTotal) * 100)
        : (job.phase === 'done' ? 100 : 0),
      startedAt: job.startedAt,
      actualStartedAt: job.actualStartedAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt,
      error: job.error,
      warning: job.warning,
      outputPath: job.outputPath,
      model: job.model,
      reasoningEffort: job.reasoningEffort,
      schedule: job.schedule,
      notBefore: job.notBefore,
      scheduledFor: job.notBefore,
      pricingPeriod: job.pricingPeriod,
      charsIn: job.charsIn,
      charsOut: job.charsOut,
      tokensIn: job.usage?.inputTokens ?? 0,
      tokensOut: job.usage?.outputTokens ?? 0,
      usage: job.usage,
      estimatedCostCny: job.estimatedCostCny ?? 0,
      costCny: job.estimatedCostCny ?? 0,
      costEstimated: true,
      pricingUpdatedAt: '2026-10-21',
      cacheHitTokens: job.usage?.cacheHitTokens ?? 0,
      cacheMissTokens: job.usage?.cacheMissTokens ?? 0,
      reasoningTokens: job.usage?.reasoningTokens ?? 0,
      visibleOutputTokens: Math.max(
        0,
        (job.usage?.outputTokens ?? 0) - (job.usage?.reasoningTokens ?? 0),
      ),
      localCacheHits: job.localCacheHits ?? 0,
      reusedChunks: job.localCacheHits ?? 0,
      apiChunks: job.apiChunks ?? 0,
      retryCount: job.retryCount ?? 0,
      retriedChunks: job.upgradedChunks ?? 0,
      validationFailures: job.validationFailures ?? 0,
      droppedFormulas: job.droppedFormulas ?? 0,
      budgetRetries: job.budgetRetries ?? 0,
      validation: { failures: job.validationFailures ?? 0 },
      upgradedChunks: job.upgradedChunks ?? 0,
      preprocessing: job.preprocessing ?? null,
      log: job.log.slice(-8),
    };
  }

  /** 真正执行翻译：抽取 → 分块 → 逐块调 API → 合并写入 */
  async function runTranslateJob(job, paper, tools, pipeline, apiKey, body) {
    const pdfAbs = resolveInside(paper.source);
    if (pdfAbs === undefined) throw new Error(`PDF 路径越权或不存在：${paper.source}`);

    const touch = (stage) => { job.stage = stage; job.updatedAt = new Date().toISOString(); };
    const note = (msg) => {
      job.log.push(`${new Date().toISOString().slice(11, 19)} ${msg}`);
      job.updatedAt = new Date().toISOString();
    };

    const refreshUsage = () => {
      const summary = pipeline.summarizeUsages(job.usages, job.model);
      job.usage = {
        inputTokens: summary.inputTokens,
        outputTokens: summary.outputTokens,
        cacheHitTokens: summary.cacheHitTokens,
        cacheMissTokens: summary.cacheMissTokens,
        reasoningTokens: summary.reasoningTokens,
      };
      job.estimatedCostCny = summary.estimatedCostCny;
    };
    const wait = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
    const waitForOffpeak = async () => {
      if (job.schedule !== 'offpeak') return;
      const next = pipeline.nextOffpeakTime(new Date());
      if (next.getTime() <= Date.now() + 1000) return;
      job.notBefore = next.toISOString();
      touch(`等待闲时（${next.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}）`);
      note('进入高峰时段，暂停在当前分块边界，闲时自动继续');
      await wait(next.getTime() - Date.now());
      job.notBefore = new Date().toISOString();
    };
    const isRetryable = (err) => {
      const message = String(err?.message ?? err);
      if (/\b(?:400|401|402|403)\b|api\s*key|鉴权|余额|balance|invalid\s+request/iu.test(message)) return false;
      return /\b(?:408|409|425|429|5\d\d)\b|fetch|network|timeout|timed out|aborted|econn|socket/iu.test(message);
    };

    job.phase = 'running';
    job.actualStartedAt = new Date().toISOString();
    job.notBefore = job.actualStartedAt;
    touch('抽取 PDF 文本');
    note('开始抽取 PDF 文本');
    const { md, warning } = await extractPdfText(pdfAbs, job.slug, undefined);
    job.warning = warning;
    job.charsIn = md.length;
    note(`抽取完成，${md.length} 字符`);

    // 在翻译前直接从抽取稿（包括 META 块）补齐库内元数据。不能只依赖译文：
    // 否则模型漏译页眉里的作者/期刊/日期后，原始证据就永远丢了。
    const metadataTools = await import(
      `${pathToFileURL(join(toolsRoot, 'paper_metadata.mjs')).href}?t=${Date.now()}`
    );
    const extractedMetadata = metadataTools.extractMetadataFromText(md, {
      fallbackTitle: paper.title,
      slug: paper.slug,
    });
    if (extractedMetadata.titleEn) paper.titleEn ??= extractedMetadata.titleEn;
    if (extractedMetadata.authors) paper.authors ??= extractedMetadata.authors;
    if (extractedMetadata.year) paper.year ??= extractedMetadata.year;
    if (extractedMetadata.doi) paper.doi ??= extractedMetadata.doi;
    if (extractedMetadata.journal || extractedMetadata.issn) {
      paper.journal ??= {};
      if (extractedMetadata.journal) paper.journal.name ??= extractedMetadata.journal;
      if (extractedMetadata.issn) paper.journal.issn ??= extractedMetadata.issn;
    }
    const foundFields = ['titleEn', 'authors', 'year', 'doi', 'journal', 'issn']
      .filter((key) => extractedMetadata[key] != null);
    if (foundFields.length) note(`从 PDF 元数据/页眉页脚识别：${foundFields.join(', ')}`);

    // 出版信息已由本地解析器消费；参考文献、公式、引用、DOI 和 URL 也在本地
    // 剥离/保护，不再为“不要翻译这些内容”支付模型输入与复制输出费用。
    touch('本地保护公式与参考文献');
    const prepared = pipeline.prepareDocument(md);
    job.preprocessing = prepared.stats;
    if (prepared.stats.referenceChars) note(`参考文献本地保留，少发送 ${prepared.stats.referenceChars} 字符`);
    if (prepared.stats.metadataChars) note(`出版元数据本地解析，少发送 ${prepared.stats.metadataChars} 字符`);
    if (prepared.stats.protectedItems) note(`已保护 ${prepared.stats.protectedItems} 个公式/引用/DOI/URL`);

    const chunks = pipeline.chunkStructured(prepared.text, config.chunkTokens || 6000);
    if (chunks.length === 0) throw new Error('抽取后没有可翻译的内容');
    job.chunkTotal = chunks.length;
    note(`按章节/段落切成 ${chunks.length} 块（目标 ${config.chunkTokens || 6000} token）`);

    const system = tools.buildSystemPrompt({
      roleHint: config.roleHint,
      extraRules: [
        config.extraRules,
        '输入中的 @@DSH_FORMULA_nnnnnn@@、@@DSH_CITATION_nnnnnn@@、@@DSH_DOI_nnnnnn@@、'
          + '@@DSH_URL_nnnnnn@@ 是本地保护标记，必须逐字、逐个、原位置保留；不得翻译、改写、复制或遗漏。',
      ].filter(Boolean).join('\n'),
    });

    const cachePaperId = pipeline.chunkCacheKey({
      source: job.slug,
      promptVersion: 'paper-cache-directory',
      model: '',
    }).slice(0, 24);
    const cacheDir = join(libraryRoot, '.translation-cache', cachePaperId);
    await mkdir(cacheDir, { recursive: true });
    const parts = [];

    const readCachedChunk = async (file, key, source) => {
      if (body.force === true || !existsSync(file)) return null;
      try {
        const cached = JSON.parse(await readFile(file, 'utf8'));
        if (cached.version !== pipeline.PIPELINE_VERSION || cached.key !== key || typeof cached.text !== 'string') return null;
        const validation = pipeline.validateTranslation(source, cached.text, prepared.placeholders);
        return validation.ok ? cached.text : null;
      } catch {
        return null;
      }
    };
    const writeCachedChunk = async (file, value) => {
      const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(temp, `${JSON.stringify(value)}\n`, 'utf8');
      try {
        await rename(temp, file);
      } catch {
        // Windows 不允许 rename 覆盖已有目标；force 重译时直接覆盖即可。
        await writeFile(file, `${JSON.stringify(value)}\n`, 'utf8');
        try { rmSync(temp, { force: true }); } catch { /* ignore */ }
      }
    };

    for (let i = 0; i < chunks.length; i += 1) {
      if (body?.cancel === true) throw new Error('已取消');
      await waitForOffpeak();
      job.chunkIndex = i;
      touch(`翻译第 ${i + 1} / ${chunks.length} 块`);
      const cacheKey = pipeline.chunkCacheKey({
        source: chunks[i],
        promptVersion: `${pipeline.PIPELINE_VERSION}\n${system}`,
        model: job.model,
        reasoningEffort: job.reasoningEffort,
        glossaryVersion: [
          config.glossaryVersion ?? '',
          paper.titleEn || paper.title || '',
          paper.source || '',
        ].join('\n'),
      });
      const cacheFile = join(cacheDir, `${cacheKey}.json`);
      const cached = await readCachedChunk(cacheFile, cacheKey, chunks[i]);
      if (cached !== null) {
        parts.push(cached);
        job.localCacheHits += 1;
        note(`第 ${i + 1}/${chunks.length} 块命中本地缓存（本次 0 token）`);
        continue;
      }

      /*
       * 升级链：同模型重采样 → 同模型再试 → 更贵的 qualityModel，全程不主动开思考。
       * 思考 token 与正文共用 max_tokens，长块上很容易把预算吃光、一个正文都不输出。
       */
      const attempts = pipeline.buildTranslationAttempts({
        model: job.model,
        qualityModel: job.qualityModel,
        reasoningEffort: job.reasoningEffort,
        qualityEscalation: config.enableQualityEscalation !== false,
      });

      let accepted = null;
      let lastValidation = null;
      let actualAttempt = null;
      let responseText = '';
      const t0 = Date.now();
      for (let qualityIndex = 0; qualityIndex < attempts.length; qualityIndex += 1) {
        const attempt = attempts[qualityIndex];
        if (qualityIndex > 0) {
          job.retryCount += 1;
          job.upgradedChunks += qualityIndex === 1 ? 1 : 0;
          note(`第 ${i + 1} 块升级为 ${attempt.model}/${attempt.reasoningEffort} 复核重译`);
        }
        const user = tools.buildUserPrompt({
          chunk: chunks[i], index: i, total: chunks.length,
          title: paper.titleEn || paper.title, source: paper.source,
        });
        const transportRetries = Math.max(0, Math.min(3, Number(config.requestRetries ?? 2)));
        let response = null;
        let transportAttempt = 0;
        let budgetAttempt = 0;
        /*
         * 预算重试只有在「上限还能真的变大」时才有意义：inputRatio 翻倍后仍被
         * job.maxTokens 截住的话，再试只是白烧钱。这里先算出下一档的实际上限。
         */
        const estimatedInput = Math.max(1, tools.estimateTokens(user));
        const capFor = (level) => Math.min(
          job.maxTokens,
          Math.ceil(estimatedInput * pipeline.nextOutputRatio(level) + 768),
        );
        const canEnlarge = (currentCap) => capFor(budgetAttempt + 1) > Number(currentCap ?? 0) + 128;
        const recordUsage = (usage, requestedAt) => {
          if (!usage) return;
          const requestPeriod = pipeline.isPeakShanghai(new Date(requestedAt)) ? 'peak' : 'offpeak';
          if (job.usages.length === 0) job.pricingPeriod = requestPeriod;
          else if (job.pricingPeriod !== requestPeriod) job.pricingPeriod = 'mixed';
          job.usages.push({
            ...usage,
            requestedAt,
            model: attempt.model,
            reasoningEffort: attempt.reasoningEffort,
          });
          refreshUsage();
        };
        while (response === null) {
          const requestedAt = new Date().toISOString();
          job.apiChunks += 1;
          try {
            const result = await tools.callDeepSeek({
              baseUrl: config.baseUrl || tools.DEFAULT_BASE_URL,
              apiKey,
              model: attempt.model,
              system,
              user,
              reasoningEffort: attempt.reasoningEffort,
              maxTokens: {
                min: Math.min(2048, job.maxTokens),
                max: job.maxTokens,
                inputRatio: pipeline.nextOutputRatio(budgetAttempt),
                base: 768,
              },
              timeoutMs: config.requestTimeoutMs || 600000,
            });
            recordUsage(result.usage, requestedAt);
            /*
             * 输出被截断（正文写满 max_tokens）或思考把预算吃光，都不是致命错误：
             * 上限还能变大时先放大重试同一块；已经顶到 job.maxTokens 就交给校验，
             * 由下一档（更强的模型）处理或给出明确失败原因，避免空转烧钱。
             */
            if (result.truncated && budgetAttempt < pipeline.MAX_BUDGET_RETRIES
                && canEnlarge(result.maxTokens)) {
              budgetAttempt += 1;
              job.retryCount += 1;
              job.budgetRetries = (job.budgetRetries ?? 0) + 1;
              note(`第 ${i + 1} 块输出被截断，放大输出上限后重试（第 ${budgetAttempt} 次）`);
              continue;
            }
            response = result;
          } catch (err) {
            if (err?.usage) recordUsage(err.usage, requestedAt);
            if (err?.code === 'max_tokens') {
              if (budgetAttempt < pipeline.MAX_BUDGET_RETRIES && canEnlarge(err.maxTokens)) {
                budgetAttempt += 1;
                job.retryCount += 1;
                job.budgetRetries = (job.budgetRetries ?? 0) + 1;
                note(`第 ${i + 1} 块输出预算不足（推理 ${err.thinkingChars ?? 0} 字），放大上限后重试`);
                continue;
              }
              throw new Error(
                `第 ${i + 1} 块在 maxTokens=${err.maxTokens} 下仍无正文输出且已到上限；`
                + '请提高 maxTokens 或减小 chunkTokens 后重试。',
              );
            }
            if (transportAttempt >= transportRetries || !isRetryable(err)) throw err;
            transportAttempt += 1;
            job.retryCount += 1;
            const delay = Math.min(8000, 1000 * (2 ** (transportAttempt - 1)));
            note(`第 ${i + 1} 块请求失败，${delay / 1000}s 后只重试本块：${err?.message ?? err}`);
            await wait(delay);
          }
        }
        lastValidation = (() => {
          // 先做确定性修复（重复的引用标记），再校验：一个多余的 [12] 不值得整块重译。
          const repaired = pipeline.repairDuplicatePlaceholders(
            chunks[i], response.text, prepared.placeholders,
          );
          if (repaired.repairs.length) {
            note(`第 ${i + 1} 块去重占位符 ${repaired.repairs.reduce((n, r) => n + r.removed, 0)} 处`);
          }
          responseText = repaired.text;
          return pipeline.validateTranslation(
            chunks[i], responseText, prepared.placeholders, { truncated: response.truncated },
          );
        })();
        if (lastValidation.ok) {
          accepted = responseText.trim();
          actualAttempt = attempt;
          if (lastValidation.warnings.length) {
            for (const warning of lastValidation.warnings) {
              const dropped = /^formula-dropped:(\d+)$/u.exec(warning);
              if (dropped) job.droppedFormulas += Number(dropped[1]);
            }
            note(`第 ${i + 1} 块提示：${lastValidation.warnings.join(', ')}`);
          }
          break;
        }
        job.validationFailures += 1;
        note(`第 ${i + 1} 块完整性校验未通过：${lastValidation.errors.join(', ')}`);
      }

      if (accepted === null) {
        const reasons = lastValidation?.errors ?? [];
        // 截断是最常见、也最容易误读的失败原因：明确告诉用户该调哪里
        const hint = reasons.includes('truncated')
          ? `（输出被 max_tokens=${job.maxTokens} 截断；请提高 maxTokens 或减小 chunkTokens）`
          : '';
        throw new Error(
          `第 ${i + 1} 块经分级重译仍未通过完整性校验：${reasons.join(', ') || '未知错误'}${hint}`,
        );
      }
      parts.push(accepted);
      await writeCachedChunk(cacheFile, {
        version: pipeline.PIPELINE_VERSION,
        key: cacheKey,
        slug: job.slug,
        chunk: i,
        text: accepted,
        requestedModel: job.model,
        actualModel: actualAttempt.model,
        reasoningEffort: actualAttempt.reasoningEffort,
        createdAt: new Date().toISOString(),
      });
      note(`第 ${i + 1}/${chunks.length} 块完成并落盘（${((Date.now() - t0) / 1000).toFixed(1)}s，`
        + `${accepted.length} 字）`);
    }
    job.chunkIndex = chunks.length;

    const restoredParts = parts.map((part) => pipeline.restoreTechnicalTokens(
      part, prepared.placeholders,
    ).trim());
    job.charsOut = restoredParts.reduce((sum, part) => sum + part.length, 0) + prepared.references.length;

    // 合并并写入译稿
    const header = [
      `# ${paper.titleZh ?? paper.title ?? job.slug}`,
      '',
      paper.titleEn ? `**原文标题**：${paper.titleEn}` : null,
      paper.authors ? `**作者**：${paper.authors}` : null,
      paper.journal?.name ? `**期刊**：${paper.journal.name}` : null,
      paper.year ? `**发表年份**：${paper.year}` : null,
      paper.doi ? `**DOI**：${paper.doi}` : null,
      paper.source ? `**原文**：\`${paper.source}\`` : null,
      '',
      '> 本文由「文献库」面板直连 DeepSeek API 翻译生成。',
      warning ? `> ⚠ ${warning}` : null,
      '',
      '---',
      '',
    ].filter((x) => x !== null).join('\n');

    let references = prepared.references.trim();
    if (references && !/^(?:#{1,4}\s*)?(?:references|bibliography|literature\s+cited|参考文献)\s*$/imu.test(
      references.split('\n').slice(0, 3).join('\n'),
    )) {
      references = `## References\n\n${references}`;
    }
    const outputBody = [restoredParts.join('\n\n'), references].filter(Boolean).join('\n\n---\n\n');

    const outRel = job.outputPath;
    const outAbs = resolveInside(outRel) ?? resolve(join(libraryRoot, 'translations', job.slug, `${job.slug}.md`));
    if (!outAbs.startsWith(resolve(join(libraryRoot, 'translations')) + sep)) {
      throw new Error(`译稿输出路径越权：${outRel}`);
    }
    await mkdir(dirname(outAbs), { recursive: true });
    const output = header + outputBody;
    await writeFile(outAbs, output, 'utf8');
    note(`已写入 ${outRel}`);

    // 登记为已翻译并刷新索引
    const { db, path: dbPath } = await loadDb();
    const p = (db.papers ?? []).find((x) => x.slug === job.slug);
    if (p) {
      // 抽取产物也记上，便于面板显示与追溯
      p.extracted = relative(workspaceRoot, join(libraryRoot, 'extracted', job.slug, `${job.slug}.md`)).replace(/\\/g, '/');
      p.translation = outRel;
      p.status = 'translated';
      p.translatedAt = new Date().toISOString();
      p.translateMethod = 'deepseek-api';
      p.translateModel = job.model;
      p.translationStats = {
        ...job.usage,
        estimatedCostCny: job.estimatedCostCny,
        localCacheHits: job.localCacheHits,
        apiChunks: job.apiChunks,
        retryCount: job.retryCount,
        validationFailures: job.validationFailures,
        chunkTotal: job.chunkTotal,
        schedule: job.schedule,
        finishedAt: new Date().toISOString(),
      };
      p.hidden = p.hidden === true;
      const local = metadataTools.extractMetadataFromText(output, {
        fallbackTitle: p.title,
        slug: p.slug,
      });
      if (extractedMetadata.titleEn) p.titleEn ??= extractedMetadata.titleEn;
      if (extractedMetadata.authors) p.authors ??= extractedMetadata.authors;
      if (extractedMetadata.year) p.year ??= extractedMetadata.year;
      if (extractedMetadata.doi) p.doi ??= extractedMetadata.doi;
      if (extractedMetadata.journal || extractedMetadata.issn) {
        p.journal ??= {};
        if (extractedMetadata.journal) p.journal.name ??= extractedMetadata.journal;
        if (extractedMetadata.issn) p.journal.issn ??= extractedMetadata.issn;
      }
      if (local.titleZh) {
        p.titleZh = local.titleZh;
        if (!p.title || p.title === p.slug) p.title = local.titleZh;
      }
      if (local.titleEn && local.evidence?.includes('labeled-title')) p.titleEn ??= local.titleEn;
      if (local.authors) p.authors ??= local.authors;
      if (local.year) p.year ??= local.year;
      await saveDb(db, dbPath);
      await refreshIndex();
    }

    job.phase = 'done';
    touch('完成');
    job.finishedAt = new Date().toISOString();
    job.notBefore = null;
    ctx.logger?.info?.(
      `literature-library: 翻译完成 ${job.slug}（${chunks.length} 块，`
      + `本地缓存 ${job.localCacheHits} 块，API 请求 ${job.apiChunks} 次，`
      + `预计 ¥${job.estimatedCostCny.toFixed(4)}）→ ${outRel}`,
    );
  }

  // ── 动作：创建翻译会话并投递提示词（备用路径） ──

  async function handleTranslate(body, origin) {
    const slug = typeof body.slug === 'string' ? body.slug : '';
    if (slug === '') throw Object.assign(new Error('缺少 slug'), { status: 400 });

    const { db } = await loadDb();
    const paper = (db.papers ?? []).find((p) => p.slug === slug);
    if (!paper) throw Object.assign(new Error(`文献库中没有 ${slug}`), { status: 404 });
    if (!paper.source) throw Object.assign(new Error(`${slug} 没有登记原始 PDF`), { status: 400 });

    const agents = ctx.get?.('agents');
    if (!agents) throw Object.assign(new Error('本部署没有 agents 服务，无法投递提示词'), { status: 501 });

    const llm = await importDshModule('@deepseek-ai/dsh-llm');
    const sessionMod = await importDshModule('@deepseek-ai/dsh-session');

    // 诊断信息：一路收集，最终随响应返回，避免「返回 200 但什么都没发生」
    const diag = {
      hasCreateUserMessage: typeof llm.createUserMessage === 'function',
      hasSessionId: typeof sessionMod.SessionId,
      modelSelection: null,
      agentShape: null,
      followupCalled: false,
      followupError: null,
      renameError: null,
      warnings: [],
    };
    if (!diag.hasCreateUserMessage) diag.warnings.push('dsh-llm 没有导出 createUserMessage');
    if (diag.hasSessionId !== 'function') diag.warnings.push(`dsh-session.SessionId 类型异常：${diag.hasSessionId}`);

    // 取默认模型：`ctx.agentDefaultModel.currentSelection()` → { provider, model, reasoningEffort }。
    // 取不到就退回配置里的 provider/model（便于部署时显式指定）。
    // 拿不到任何模型信息时**直接报错**，而不是建一个永远不动的会话。
    const selection = (() => {
      try {
        const svc = ctx.get?.('agentDefaultModel');
        if (svc?.currentSelection) return svc.currentSelection();
      } catch (err) { diag.warnings.push(`读取默认模型失败：${err?.message ?? err}`); }
      if (config.provider && config.model) {
        return {
          provider: config.provider,
          model: config.model,
          ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
        };
      }
      return null;
    })();
    diag.modelSelection = selection;
    if (selection === null) {
      throw Object.assign(
        new Error('拿不到默认模型（agentDefaultModel 服务与配置都没有），无法创建能工作的翻译会话'),
        { status: 501 },
      );
    }
    const agentOptions = {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    };

    const sessionId = typeof sessionMod.SessionId === 'function'
      ? sessionMod.SessionId(`sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
      : `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    const handle = await agents.create({
      sessionId,
      meta: { cwd: workspaceRoot, ...(config.agentPreset ? { agentPreset: config.agentPreset } : {}) },
      // ★ 必须给 agentOptions：只建会话不指定模型的话，agent 无法发起模型请求，
      //   `followup()` 会被静默丢弃——表现为「接口返回 200、会话文件里只有头事件、
      //   会话列表里能看到但永远不动」。这就是「一键翻译不工作」的真正原因。
      //   字段取自 DSH 自己的用法（dsh-sdk-jsonrpc-server / dsh-headless）。
      ...(agentOptions ? { agentOptions } : {}),
    });
    diag.agentShape = handle === null || handle === undefined
      ? String(handle)
      : Object.keys(handle).join(',');
    const agent = handle?.agent ?? handle;
    diag.hasFollowup = typeof agent?.followup === 'function';
    diag.hasSession = agent?.session !== undefined && agent?.session !== null;

    if (paper.year && diag.hasSession) {
      try { ctx.get?.('sessionTitle')?.rename(agent.session, `${paper.title}-${paper.year}-翻译`); }
      catch (err) { diag.renameError = String(err?.message ?? err); }
    }

    // 译稿路径固定在库内，不跟随原始 PDF 的位置
    const outPath = paper.translation || paper.translationPath
      || `${libraryDir}/translations/${slug}/${slug}.md`;

    const prompt = [
      '/translate-paper',
      '',
      `请翻译这篇文献：${paper.source}`,
      '',
      '要求：按技能里的九条硬性要求执行。',
      `译稿必须写入：${outPath}`,
      '（该路径固定在文献库内，不要放到原 PDF 所在目录。）',
      '完成后用 tools/library.mjs 把它登记为已翻译（status=translated）并重新导出索引。',
    ].join('\n');

    // 投递提示词。**不要吞掉这里的异常**：早先整段没有 try/catch 外的反馈，
    // 导致「接口返回 200、会话却只有头事件」，排查花了很多时间。
    try {
      if (!diag.hasFollowup) throw new Error(`agent 上没有 followup 方法（handle keys: ${diag.agentShape}）`);
      agent.followup(llm.createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }));
      diag.followupCalled = true;
    } catch (err) {
      diag.followupError = String(err?.message ?? err);
      diag.warnings.push(`提示词投递失败：${diag.followupError}`);
      ctx.logger?.warn?.(`literature-library: 提示词投递失败 — ${diag.followupError}`);
    }

    if (diag.warnings.length) {
      ctx.logger?.warn?.(`literature-library: 翻译投递有警告 — ${diag.warnings.join('；')}`);
    } else {
      ctx.logger?.info?.(`literature-library: 已向会话 ${sessionId} 投递翻译提示词`);
    }

    // 把会话 id 记到文献条目上，让面板能查询并显示这篇的翻译进度
    try {
      const { db: db2, path: dbPath2 } = await loadDb();
      const p2 = (db2.papers ?? []).find((p) => p.slug === slug);
      if (p2) {
        p2.translateSession = String(sessionId);
        p2.translateStartedAt = new Date().toISOString();
        p2.translateStatus = diag.followupCalled ? 'running' : 'failed';
        await saveDb(db2, dbPath2);
        await refreshIndex();
      }
    } catch (err) {
      diag.warnings.push(`记录翻译会话失败：${err?.message ?? err}`);
    }

    return {
      ok: diag.followupCalled,
      sessionId: String(sessionId),
      url: `${origin}/?session=${encodeURIComponent(String(sessionId))}`,
      title: paper.title,
      source: paper.source,
      outputPath: outPath,
      diag,
    };
  }

  // ── 路由 ──

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: prefix,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const sub = url.pathname.slice(prefix.length).replace(/^\/+/, '');
        const origin = `http://${req.headers.host ?? '127.0.0.1'}`;

        // 索引
        if (sub === '' || sub === 'index' || sub === 'index.json') {
          if (req.method !== 'GET' && req.method !== 'HEAD') { sendJson(res, 405, { error: 'method-not-allowed' }); return; }
          const indexAbs = join(libraryRoot, 'index.json');
          try {
            await refreshIndex();
            const text = await readFile(indexAbs, 'utf8');
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'content-length': Buffer.byteLength(text),
              'cache-control': 'no-store',
            });
            res.end(req.method === 'HEAD' ? undefined : text);
          } catch {
            sendJson(res, 404, {
              error: 'index-missing',
              hint: `未找到 ${indexAbs}。请在该目录执行 node tools/library.mjs export`
                + `；已尝试的候选工作区：${detected.tried.join(' | ')}`,
              tried: detected.tried,
            });
          }
          return;
        }

        // 版本号：界面左下角的 vX.Y.Z 从这里来；也方便升级后一眼确认实例是否已重启
        if (sub === 'version') {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { error: 'method-not-allowed' }); return;
          }
          sendJson(res, 200, {
            name: PLUGIN_PACKAGE.name ?? 'dsh-literature-library',
            version: PLUGIN_VERSION,
            pdfjs: true,
            range: true,
            routePrefix: prefix,
          });
          return;
        }

        // 离线更新：扫描本地 updates/ 或上传一个 npm pack 的 .tgz。
        // 全程只读写本机文件，不需要 GitHub、npm 或任何外网。
        if (sub === 'plugin-update') {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { error: 'method-not-allowed' }); return;
          }
          sendJson(res, 200, {
            current: PLUGIN_VERSION,
            name: PLUGIN_PACKAGE.name ?? 'dsh-literature-library',
            updatesDir,
            packages: listUpdatePackages(),
            last: readLastUpdate(),
          });
          return;
        }

        if (sub === 'plugin-update/github') {
          if (req.method !== 'GET' && req.method !== 'POST') {
            sendJson(res, 405, { error: 'method-not-allowed' }); return;
          }
          try {
            if (req.method === 'GET') {
              const info = await fetchGithubLatest();
              sendJson(res, 200, info);
            } else {
              const result = await downloadGithubUpdate();
              sendJson(res, 200, result);
            }
          } catch (err) {
            sendJson(res, Number(err?.status) || 502, {
              error: 'github-update-failed',
              message: String(err?.message ?? err),
            });
          }
          return;
        }

        if (sub === 'plugin-update/apply') {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method-not-allowed' }); return;
          }
          try {
            const type = String(req.headers['content-type'] ?? '').toLowerCase();
            let fileName;
            let buffer;
            if (type.includes('application/json')) {
              const body = await readBody(req, 64 * 1024);
              fileName = basename(String(body?.file ?? ''));
              if (!/\.(?:tgz|tar\.gz)$/iu.test(fileName)) {
                throw Object.assign(new Error('请选择 .tgz 或 .tar.gz 更新包'), { status: 400 });
              }
              const abs = join(updatesDir, fileName);
              if (!existsSync(abs)) {
                throw Object.assign(new Error(`更新包不存在：${fileName}`), { status: 404 });
              }
              buffer = readFileSync(abs);
            } else {
              buffer = await readRawBody(req);
              fileName = basename(String(url.searchParams.get('name') ?? 'update.tgz'));
              if (!/\.(?:tgz|tar\.gz)$/iu.test(fileName)) fileName = 'update.tgz';
              mkdirSync(updatesDir, { recursive: true });
              writeFileSync(join(updatesDir, fileName), buffer);
            }
            const result = applyUpdateBuffer(buffer, fileName);
            sendJson(res, 200, result);
          } catch (err) {
            sendJson(res, Number(err?.status) || 400, {
              error: 'update-failed',
              message: String(err?.message ?? err),
            });
          }
          return;
        }

        // 插件自带的静态资源（目前是 KaTeX 的本地副本，供 CDN 不可达时兜底）
        if (sub === 'vendor') {
          if (req.method !== 'GET' && req.method !== 'HEAD') { sendJson(res, 405, { error: 'method-not-allowed' }); return; }
          const name = url.searchParams.get('name') ?? '';
          // 只允许白名单文件名——绝不把任意路径拼进来
          const allowed = { 'katex.min.js': 'text/javascript; charset=utf-8', 'katex.min.css': 'text/css; charset=utf-8' };
          const type = allowed[name];
          if (!type) { sendJson(res, 404, { error: 'vendor-not-allowed', name }); return; }
          const abs = join(fileURLToPath(new URL('.', import.meta.url)), 'vendor', name);
          if (!existsSync(abs)) {
            sendJson(res, 404, { error: 'vendor-missing', name, hint: `请把 ${name} 放到插件的 vendor/ 目录` });
            return;
          }
          const body = await readFile(abs);
          res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-store' });
          res.end(req.method === 'HEAD' ? undefined : body);
          return;
        }

        // PDF.js 运行时（客户端用 canvas 自己渲染，避免内置 PDF 阅读器反复创建）
        if (sub.startsWith('pdfjs/')) {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { error: 'method-not-allowed' }); return;
          }
          let rel = '';
          try { rel = decodeURIComponent(sub.slice('pdfjs/'.length)).replace(/\\/g, '/'); } catch { /* 非法转义 */ }
          const allowed = /^(?:build\/(?:pdf|pdf\.worker|pdf\.sandbox)(?:\.min)?\.mjs|cmaps\/[A-Za-z0-9._-]+\.bcmap|standard_fonts\/[A-Za-z0-9._-]+\.(?:pfb|ttf)|wasm\/[A-Za-z0-9._-]+\.(?:wasm|js)|iccs?\/[A-Za-z0-9._-]+\.icc)$/u;
          if (rel === '' || !allowed.test(rel)) {
            sendJson(res, 403, { error: 'pdfjs-not-allowed', path: rel });
            return;
          }
          const abs = resolve(pdfjsRoot, rel);
          if (!abs.startsWith(pdfjsRoot + sep) || !existsSync(abs)) {
            sendJson(res, 404, { error: 'pdfjs-missing', path: rel, hint: '工作区缺少 node_modules/pdfjs-dist' });
            return;
          }
          const type = MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream';
          const body = await readFile(abs);
          res.writeHead(200, {
            'content-type': type,
            'content-length': body.length,
            'cache-control': 'public, max-age=31536000, immutable',
          });
          res.end(req.method === 'HEAD' ? undefined : body);
          return;
        }

        // 库内文件
        if (sub === 'file') {
          if (req.method !== 'GET' && req.method !== 'HEAD') { sendJson(res, 405, { error: 'method-not-allowed' }); return; }
          const rel = url.searchParams.get('path');
          const abs = resolveInside(rel);
          if (abs === undefined) { sendJson(res, 403, { error: 'forbidden', path: rel }); return; }
          let info;
          try { info = await stat(abs); } catch { sendJson(res, 404, { error: 'not-found', path: rel }); return; }
          if (!info.isFile()) { sendJson(res, 404, { error: 'not-a-file', path: rel }); return; }
          const type = MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream';
          const common = {
            'content-type': type,
            'cache-control': 'no-store',
            'accept-ranges': 'bytes',
          };
          const pipe = (start, end) => {
            const stream = createReadStream(abs, start === undefined ? undefined : { start, end });
            stream.on('error', () => {
              try { res.destroy(); } catch { /* 已断开 */ }
            });
            res.on('close', () => stream.destroy());
            stream.pipe(res);
          };

          /*
           * 支持 Range：PDF.js 只需要按块拉取当前页附近的数据，
           * 149MB 的论文也不必整份下载；内置阅读器同样会用到 206。
           */
          const rangeHeader = String(req.headers.range ?? '').trim();
          if (rangeHeader !== '') {
            const match = /^bytes=(\d*)-(\d*)$/u.exec(rangeHeader);
            if (match === null) {
              res.writeHead(416, { ...common, 'content-range': `bytes */${info.size}` });
              res.end();
              return;
            }
            let start = match[1] === '' ? null : Number(match[1]);
            let end = match[2] === '' ? null : Number(match[2]);
            if (start === null) {
              // 后缀范围：bytes=-500 表示最后 500 字节
              if (end === null || !Number.isSafeInteger(end) || end <= 0) {
                res.writeHead(416, { ...common, 'content-range': `bytes */${info.size}` });
                res.end();
                return;
              }
              start = Math.max(0, info.size - end);
              end = info.size - 1;
            } else if (end === null || end >= info.size) {
              end = info.size - 1;
            }
            const valid = Number.isSafeInteger(start) && Number.isSafeInteger(end)
              && start >= 0 && start <= end && start < info.size;
            if (!valid) {
              res.writeHead(416, { ...common, 'content-range': `bytes */${info.size}` });
              res.end();
              return;
            }
            res.writeHead(206, {
              ...common,
              'content-length': end - start + 1,
              'content-range': `bytes ${start}-${end}/${info.size}`,
            });
            if (req.method === 'HEAD') { res.end(); return; }
            pipe(start, end);
            return;
          }

          res.writeHead(200, { ...common, 'content-length': info.size });
          if (req.method === 'HEAD') { res.end(); return; }
          /*
           * PDF 可能几十 MB。原先 `readFile` 会把整份文件读进内存再写回，
           * 客户端频繁切换、中途 abort 时服务端仍会把文件读完——既占内存又拖慢
           * 下一次请求。改成流式：客户端断开时 `res` 触发 close，立刻销毁读流。
           */
          pipe(undefined, undefined);
          return;
        }

        // 扫描登记
        if (sub === 'scan') {
          if (req.method !== 'POST') { sendJson(res, 405, { error: 'use-post' }); return; }
          try {
            const result = await handleScan(await readBody(req));
            ctx.logger?.info?.(`literature-library: 扫描 ${result.dir} — 新增 ${result.added.length} 篇`);
            sendJson(res, 200, result);
          } catch (err) {
            sendJson(res, err?.status ?? 500, { error: 'scan-failed', message: String(err?.message ?? err) });
          }
          return;
        }

        // 按分类扫描原始来源文件夹（只复制新增 PDF）
        if (sub === 'scan-source') {
          if (req.method !== 'POST') { sendJson(res, 405, { error: 'use-post' }); return; }
          try {
            const result = await handleScanSource(await readBody(req));
            ctx.logger?.info?.(`literature-library: 扫描来源 ${result.source} → ${result.folder} — 新增 ${result.added.length} 篇`);
            sendJson(res, 200, result);
          } catch (err) {
            sendJson(res, err?.status ?? 500, { error: 'scan-source-failed', message: String(err?.message ?? err) });
          }
          return;
        }

        // 目录浏览（host 自己实现，供「添加文件夹」用）
        if (sub === 'browse') {
          if (req.method !== 'GET') { sendJson(res, 405, { error: 'use-get' }); return; }
          if (allowBrowse === false) {
            sendJson(res, 403, { error: 'browse-disabled', message: '已通过配置关闭目录浏览' });
            return;
          }
          try {
            const listing = await listDirectory(url.searchParams.get('path'));
            sendJson(res, 200, listing);
          } catch (err) {
            sendJson(res, err?.status ?? 500, { error: 'browse-failed', message: String(err?.message ?? err) });
          }
          return;
        }

        // 添加外部文件夹（复制进库，保留子目录层级）
        if (sub === 'add-folder') {
          if (req.method !== 'POST') { sendJson(res, 405, { error: 'use-post' }); return; }
          try {
            const result = await handleAddFolder(await readBody(req));
            if (result.dryRun) { sendJson(res, 200, result); return; }
            ctx.logger?.info?.(
              `literature-library: 已从 ${result.dir} 导入 ${result.copied} 个 PDF → ${result.dest}`
              + `（新增 ${result.added.length} 篇，跳过 ${result.skipped.length} 篇）`,
            );
            sendJson(res, 200, result);
          } catch (err) {
            ctx.logger?.warn?.(`literature-library: 添加文件夹失败 — ${err?.message ?? err}`);
            sendJson(res, err?.status ?? 500, { error: 'add-folder-failed', message: String(err?.message ?? err) });
          }
          return;
        }

        // 保存译文
        if (sub === 'save') {
          if (req.method !== 'POST') { sendJson(res, 405, { error: 'use-post' }); return; }
          try {
            const result = await handleSaveTranslation(await readBody(req, 8 * 1024 * 1024));
            ctx.logger?.info?.(`literature-library: 已保存译稿 ${result.path}（${result.bytes} 字节）`);
            sendJson(res, 200, result);
          } catch (err) {
            sendJson(res, err?.status ?? 500, { error: 'save-failed', message: String(err?.message ?? err) });
          }
          return;
        }

        // 更新元数据（期刊信息等）
        if (sub === 'update') {
          if (req.method !== 'POST') { sendJson(res, 405, { error: 'use-post' }); return; }
          try {
            const result = await handleUpdateMetadata(await readBody(req));
            ctx.logger?.info?.(`literature-library: 已更新 ${result.paper.slug} 的 ${result.changed.length} 个字段`);
            sendJson(res, 200, result);
          } catch (err) {
            sendJson(res, err?.status ?? 500, { error: 'update-failed', message: String(err?.message ?? err) });
          }
          return;
        }

        // 翻译会话列表与进度
        if (sub === 'sessions') {
          if (req.method !== 'GET') { sendJson(res, 405, { error: 'use-get' }); return; }
          try {
            sendJson(res, 200, await handleSessions());
          } catch (err) {
            sendJson(res, 500, { error: 'sessions-failed', message: String(err?.message ?? err) });
          }
          return;
        }

        // 单个会话的进度（面板轮询用）
        if (sub === 'progress') {
          if (req.method !== 'GET') { sendJson(res, 405, { error: 'use-get' }); return; }
          const id = url.searchParams.get('sessionId');
          if (!id || !isPluginSessionId(id)) {
            sendJson(res, 400, { error: 'bad-session-id', message: '需要一个 sess- 开头的会话 id' });
            return;
          }
          try {
            sendJson(res, 200, await readSessionProgress(
              sessionsRootDir(), workspaceRoot, id,
            ));
          } catch (err) {
            sendJson(res, 500, { error: 'progress-failed', message: String(err?.message ?? err) });
          }
          return;
        }

        // 按 ablesci（科研通）补全期刊信息
        if (sub === 'fill-journal') {
          if (req.method !== 'POST') { sendJson(res, 405, { error: 'use-post' }); return; }
          try {
            const result = await handleFillJournal(await readBody(req));
            if (!result.ok) {
              sendJson(res, 200, result);   // 单篇查不到不算服务器错误
            } else {
              sendJson(res, 200, result);
            }
          } catch (err) {
            ctx.logger?.warn?.(`literature-library: 补全期刊信息失败 — ${err?.message ?? err}`);
            sendJson(res, err?.status ?? 500, { error: 'fill-journal-failed', message: String(err?.message ?? err) });
          }
          return;
        }

        // 隐藏 / 取消隐藏 / 删除（文献或整个文件夹）
        if (sub === 'mutate') {
          if (req.method !== 'POST') { sendJson(res, 405, { error: 'use-post' }); return; }
          let mutateBody = {};
          try {
            mutateBody = await readBody(req);
            const result = await handleMutate(mutateBody);
            const what = result.folder ? `文件夹「${result.folder}」` : `文献 ${result.affected?.[0] ?? ''}`;
            ctx.logger?.info?.(
              `literature-library: ${result.action} ${what}`
              + `（影响 ${(result.affected ?? result.removed ?? []).length} 篇`
              + (result.trashed?.length ? `，已移入回收站 ${result.trashed.filter((t) => t.to).length} 个文件` : '')
              + '）',
            );
            sendJson(res, 200, result);
          } catch (err) {
            // 注意：这里不要引用 try 内部才存在的变量（曾因此把 400 变成 500）
            ctx.logger?.warn?.(`literature-library: ${mutateBody?.action ?? 'mutate'} 失败 — ${err?.message ?? err}`);
            sendJson(res, err?.status ?? 500, { error: 'mutate-failed', message: String(err?.message ?? err) });
          }
          return;
        }

        // 手动排序 / 置顶（只改展示顺序，不动文件）
        if (sub === 'reorder') {
          if (req.method !== 'POST') { sendJson(res, 405, { error: 'use-post' }); return; }
          let arrangeBody = {};
          try {
            arrangeBody = await readBody(req);
            const result = await handleArrange(arrangeBody);
            ctx.logger?.info?.(
              `literature-library: ${result.action} ${result.folder ?? result.slug ?? ''}`
              + (result.ordered ? `（重排 ${result.ordered} 篇）` : ''),
            );
            sendJson(res, 200, result);
          } catch (err) {
            ctx.logger?.warn?.(`literature-library: ${arrangeBody?.action ?? 'reorder'} 失败 — ${err?.message ?? err}`);
            sendJson(res, err?.status ?? 500, { error: 'reorder-failed', message: String(err?.message ?? err) });
          }
          return;
        }

        // 直连 DeepSeek 翻译：启动任务 / 查询进度 / 列出任务
        if (sub === 'translate-job') {
          if (req.method === 'POST') {
            try {
              sendJson(res, 200, await handleTranslateJob(await readBody(req)));
            } catch (err) {
              ctx.logger?.warn?.(`literature-library: 启动翻译任务失败 — ${err?.message ?? err}`);
              sendJson(res, err?.status ?? 500, { error: 'translate-job-failed', message: String(err?.message ?? err) });
            }
            return;
          }
          if (req.method === 'GET') {
            const id = url.searchParams.get('id');
            if (id) {
              const job = translateJobs.get(id);
              if (!job) { sendJson(res, 404, { error: 'job-not-found', message: `没有任务 ${id}` }); return; }
              sendJson(res, 200, publicJob(id, job));
              return;
            }
            // 不带 id → 返回当前所有任务（面板一次性刷新用）
            const all = [...translateJobs.entries()]
              .sort((a, b) => String(b[1].startedAt).localeCompare(String(a[1].startedAt)))
              .map(([id, j]) => publicJob(id, j));
            sendJson(res, 200, { jobs: all });
            return;
          }
          sendJson(res, 405, { error: 'use-get-or-post' });
          return;
        }

        // 读/写 DeepSeek API 配置（面板里的「配置 API」按钮用）
        if (sub === 'config') {
          if (req.method === 'GET') {
            try {
              const tools = await import(`${pathToFileURL(join(toolsRoot, 'deepseek_translate.mjs')).href}?t=${Date.now()}`);
              const { key, source: keySource } = await tools.resolveApiKey(config);
              const cred = await readCredentialKey();
              sendJson(res, 200, {
                ready: Boolean(key),
                keySource,
                keyPrefix: key ? `${key.slice(0, 6)}…` : null,
                keyLength: key ? key.length : 0,
                credentialsFile: cred.file,
                credentialsFileExists: existsSync(cred.file),
                credentialsHasKey: Boolean(cred.key),
                envHasKey: Boolean(process.env.DEEPSEEK_API_KEY),
                configHasKey: typeof config.apiKey === 'string' && config.apiKey.trim() !== '',
                baseUrl: config.baseUrl || tools.DEFAULT_BASE_URL,
                model: config.model || tools.DEFAULT_MODEL,
                maxTokens: config.maxTokens || 32000,
                chunkTokens: config.chunkTokens || 6000,
                reasoningEffort: 'none',
                qualityModel: config.qualityModel || 'deepseek-v4-pro',
                translationConcurrency,
                supportsOffpeakSchedule: true,
                pricingUpdatedAt: '2026-10-21',
              });
            } catch (err) {
              sendJson(res, 500, { error: 'config-read-failed', message: String(err?.message ?? err) });
            }
            return;
          }
          if (req.method === 'POST') {
            try {
              const body = await readBody(req);
              const key = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
              if (key === '') throw Object.assign(new Error('请输入 API key'), { status: 400 });
              if (!/^sk-[A-Za-z0-9_\-]{10,}$/.test(key)) {
                throw Object.assign(
                  new Error('看起来不像 DeepSeek 的 key（应以 sk- 开头，且长度足够）'),
                  { status: 400 },
                );
              }
              const written = await writeCredentialKey(key);
              ctx.logger?.info?.(`literature-library: 已更新 API key → ${written.file}`);

              // 立刻回读一次，确认真的生效（而不是只报告「写入成功」）
              const tools = await import(`${pathToFileURL(join(toolsRoot, 'deepseek_translate.mjs')).href}?t=${Date.now()}`);
              const { key: readBack, source: keySource } = await tools.resolveApiKey(config);
              sendJson(res, 200, {
                ok: true,
                file: written.file,
                backup: written.backup,
                verified: Boolean(readBack),
                keySource,
                keyPrefix: readBack ? `${readBack.slice(0, 6)}…` : null,
              });
            } catch (err) {
              sendJson(res, err?.status ?? 500, { error: 'config-write-failed', message: String(err?.message ?? err) });
            }
            return;
          }
          sendJson(res, 405, { error: 'use-get-or-post' });
          return;
        }

        // 检查直连翻译是否就绪（key 有没有、模型是什么）
        if (sub === 'translate-config') {
          if (req.method !== 'GET') { sendJson(res, 405, { error: 'use-get' }); return; }
          try {
            const tools = await import(`${pathToFileURL(join(toolsRoot, 'deepseek_translate.mjs')).href}?t=${Date.now()}`);
            const { key, source: keySource } = await tools.resolveApiKey(config);
            sendJson(res, 200, {
              ready: Boolean(key),
              keySource,
              keyPrefix: key ? `${key.slice(0, 6)}…` : null,
              baseUrl: config.baseUrl || tools.DEFAULT_BASE_URL,
              model: config.model || tools.DEFAULT_MODEL,
              maxTokens: config.maxTokens || 32000,
              chunkTokens: config.chunkTokens || 6000,
              reasoningEffort: 'none',
              qualityModel: config.qualityModel || 'deepseek-v4-pro',
              translationConcurrency,
              supportsOffpeakSchedule: true,
              pricingUpdatedAt: '2026-10-21',
            });
          } catch (err) {
            sendJson(res, 500, { error: 'config-check-failed', message: String(err?.message ?? err) });
          }
          return;
        }

        // 投递翻译（旧的 agent 会话路径，保留作备用）
        if (sub === 'translate') {
          if (req.method !== 'POST') { sendJson(res, 405, { error: 'use-post' }); return; }
          try {
            const result = await handleTranslate(await readBody(req), origin);
            ctx.logger?.info?.(`literature-library: 已为「${result.title}」创建翻译会话 ${result.sessionId}`);
            sendJson(res, 200, result);
          } catch (err) {
            ctx.logger?.warn?.(`literature-library: 翻译投递失败 — ${err?.message ?? err}`);
            sendJson(res, err?.status ?? 500, { error: 'translate-failed', message: String(err?.message ?? err) });
          }
          return;
        }

        sendJson(res, 404, { error: 'unknown-endpoint', path: url.pathname });
      } catch (err) {
        try { sendJson(res, 500, { error: 'internal', message: String(err?.message ?? err) }); } catch { /* 连接已断 */ }
      }
    },
  }), 'literature-library: routes');
}
