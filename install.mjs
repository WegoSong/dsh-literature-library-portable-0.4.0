#!/usr/bin/env node
/** 把便携包安装到当前用户的 DSH，并自动更新 web profile。 */

import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Script } from 'node:vm';
import {
  getArg, getDshHome, makePluginBlock, removePluginConfig, updateProfile,
} from './profile-utils.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = join(HERE, 'payload');
const dshHome = getDshHome();
const targetRoot = resolve(getArg('--target') || join(dshHome, 'extensions', 'literature-library'));
const profilePath = resolve(getArg('--profile') || join(dshHome, 'profiles', 'web', 'cordis.patch.yml'));

function fail(message) {
  console.error(`\n安装失败：${message}`);
  process.exitCode = 1;
}

async function verifyPackage() {
  const manifestPath = join(HERE, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error('安装包缺少 manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const entries = Object.entries(manifest.sha256 || {});
  if (!entries.length) throw new Error('安装包清单没有文件校验信息');

  for (const [rel, expected] of entries) {
    const file = resolve(PAYLOAD, rel);
    const insidePayload = file === PAYLOAD || file.startsWith(`${PAYLOAD}\\`) || file.startsWith(`${PAYLOAD}/`);
    if (!insidePayload || !existsSync(file)) throw new Error(`安装包不完整：payload/${rel}`);
    const actual = createHash('sha256').update(await readFile(file)).digest('hex');
    if (actual !== expected) throw new Error(`安装包文件校验失败：payload/${rel}`);
  }
  return manifest;
}

async function copyRuntime() {
  const required = [
    'plugin/literature-library/index.js',
    'plugin/literature-library/client.js',
    'tools/extract_pdf.mjs',
    'tools/deepseek_translate.mjs',
    'tools/library_index.mjs',
    'tools/paper_metadata.mjs',
    'node_modules/pdfjs-dist/package.json',
    'node_modules/pdfjs-dist/build/pdf.min.mjs',
    'node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
    'library/library.json',
  ];
  for (const rel of required) {
    if (!existsSync(join(PAYLOAD, rel))) throw new Error(`安装包不完整，缺少 payload/${rel}`);
  }

  await mkdir(targetRoot, { recursive: true });
  for (const name of await readdir(PAYLOAD)) {
    if (name === 'library') continue;
    await cp(join(PAYLOAD, name), join(targetRoot, name), {
      recursive: true, force: true, preserveTimestamps: true,
    });
  }

  // 更新插件时绝不覆盖用户已有的文献库。
  const librarySource = join(PAYLOAD, 'library');
  const libraryTarget = join(targetRoot, 'library');
  await mkdir(libraryTarget, { recursive: true });
  for (const dir of ['papers', 'translations', 'extracted', 'trash']) {
    await mkdir(join(libraryTarget, dir), { recursive: true });
  }
  for (const name of ['library.json', 'index.json', 'README.md']) {
    const destination = join(libraryTarget, name);
    if (!existsSync(destination)) await cp(join(librarySource, name), destination, { force: false });
  }
}

async function verifyInstall() {
  const clientPath = join(targetRoot, 'plugin', 'literature-library', 'client.js');
  // 用 vm.Script 只做语法解析，不执行 bundle（bundle 依赖浏览器里的
  // window.__ModuleLoader__）。不调用子进程是因为受限沙箱下「父进程读子进程
  // 管道」会 EPERM，安装器会把正常的客户端误报成语法错误。
  try {
    new Script(await readFile(clientPath, 'utf8'), { filename: clientPath });
  } catch (error) {
    throw new Error(`客户端语法检查失败：${error?.message ?? error}`);
  }
  const host = await import(`${pathToFileURL(join(targetRoot, 'plugin', 'literature-library', 'index.js')).href}?install=${Date.now()}`);
  if (typeof host.apply !== 'function' || host.name !== 'literature-library') {
    throw new Error('Host 插件入口导出不完整');
  }
  const packageJson = JSON.parse(await readFile(join(targetRoot, 'node_modules', 'pdfjs-dist', 'package.json'), 'utf8'));
  if (!packageJson.version) throw new Error('pdfjs-dist 运行时损坏');
}

async function writeLauncher() {
  if (process.platform !== 'win32') return null;
  const launcher = join(targetRoot, '启动DSH.cmd');
  const escaped = targetRoot.replace(/%/g, '%%');
  const content = [
    '@echo off',
    'chcp 65001 >nul',
    `cd /d "${escaped}"`,
    'echo 正在启动 DSH Web...',
    'call npx @deepseek-ai/dsh web',
    'pause',
    '',
  ].join('\r\n');
  await writeFile(launcher, content, 'utf8');
  return launcher;
}

try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new Error(`需要 Node.js >= 22.13，当前是 ${process.version}`);
  }

  console.log('DSH 文献翻译插件便携安装器');
  console.log(`  DSH Home: ${dshHome}`);
  console.log(`  安装目录: ${targetRoot}`);
  console.log(`  Web 配置: ${profilePath}`);

  const manifest = await verifyPackage();
  await copyRuntime();
  await verifyInstall();
  const profile = await updateProfile(profilePath, (source) => {
    const clean = removePluginConfig(source).trimEnd();
    return `${clean}${clean ? '\n\n' : ''}${makePluginBlock(targetRoot)}`;
  });
  const launcher = await writeLauncher();
  const installed = {
    installedAt: new Date().toISOString(),
    packageVersion: manifest.version,
    targetRoot,
    profilePath,
    profileBackup: profile.backup,
  };
  await writeFile(join(targetRoot, '.portable-install.json'), `${JSON.stringify(installed, null, 2)}\n`, 'utf8');

  console.log('\n✓ 安装完成');
  console.log('  已注册 Host 与 Web 客户端插件。');
  console.log('  文献库为空，可在面板里用“添加文件夹”导入 PDF。');
  if (profile.backup) console.log(`  原配置备份：${profile.backup}`);
  if (launcher) console.log(`  重启入口：${launcher}`);
  console.log('\n请关闭当前 DSH 进程后重新启动；仅刷新浏览器不会更新 Host 插件。');
} catch (error) {
  fail(error?.stack || error?.message || String(error));
}
