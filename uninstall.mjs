#!/usr/bin/env node
/** 默认只从 DSH profile 注销插件，保留全部文献与安装文件。 */

import { rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getArg, getDshHome, removePluginConfig, updateProfile } from './profile-utils.mjs';

const dshHome = getDshHome();
const targetRoot = resolve(getArg('--target') || join(dshHome, 'extensions', 'literature-library'));
const profilePath = resolve(getArg('--profile') || join(dshHome, 'profiles', 'web', 'cordis.patch.yml'));

try {
  const result = await updateProfile(profilePath, removePluginConfig);
  console.log('✓ 已从 DSH web profile 注销文献翻译插件。');
  if (result.backup) console.log(`  配置备份：${result.backup}`);

  if (process.argv.includes('--remove-files') && existsSync(targetRoot)) {
    const trashRoot = join(dshHome, 'trash');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = join(trashRoot, `literature-library-${stamp}`);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(trashRoot, { recursive: true });
    await rename(targetRoot, destination);
    console.log(`  安装目录已移动到可恢复位置：${destination}`);
  } else {
    console.log(`  文献与安装文件仍保留在：${targetRoot}`);
    console.log('  如需移走文件，可运行：node uninstall.mjs --remove-files');
  }
  console.log('请重启 DSH 使注销生效。');
} catch (error) {
  console.error(`卸载失败：${error?.stack || error}`);
  process.exitCode = 1;
}
