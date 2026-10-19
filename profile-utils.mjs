import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const BLOCK_START = '# >>> dsh-literature-library portable >>>';
export const BLOCK_END = '# <<< dsh-literature-library portable <<<';

export function getDshHome() {
  return resolve(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'));
}

export function getArg(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

export function yamlQuote(value) {
  return `'${String(value).replace(/\\/g, '/').replace(/'/g, "''")}'`;
}

/**
 * 删除本安装器写入的标记块，并兼容清理早期手工添加的同 id 插件条目。
 * 只处理 `insert` 块里的 literature-library 两个 id，不触碰其它 DSH 配置。
 */
export function removePluginConfig(source) {
  const normalized = String(source ?? '').replace(/\r\n/g, '\n');
  const marked = normalized.replace(
    new RegExp(`^${escapeRegExp(BLOCK_START)}\\n[\\s\\S]*?^${escapeRegExp(BLOCK_END)}\\n?`, 'gm'),
    '',
  );
  const lines = marked.split('\n');
  const output = [];

  for (let i = 0; i < lines.length;) {
    if (!/^-\s+insert:\s*$/.test(lines[i])) {
      output.push(lines[i]);
      i += 1;
      continue;
    }

    const block = [lines[i]];
    i += 1;
    while (i < lines.length && !/^-\s+/.test(lines[i])) {
      block.push(lines[i]);
      i += 1;
    }

    const kept = [block[0]];
    for (let j = 1; j < block.length;) {
      const id = /^\s{4}-\s+id:\s*([^\s#]+)\s*$/.exec(block[j])?.[1];
      if (id === 'literature-library' || id === 'literature-library-client') {
        j += 1;
        while (j < block.length && !/^\s{4}-\s+id:/.test(block[j])) j += 1;
        continue;
      }
      kept.push(block[j]);
      j += 1;
    }
    if (kept.some((line) => /^\s{4}-\s+id:/.test(line))) output.push(...kept);
  }

  return `${output.join('\n').trimEnd()}\n`;
}

export function makePluginBlock(targetRoot) {
  const entry = join(targetRoot, 'plugin', 'literature-library', 'index.js');
  return [
    BLOCK_START,
    '- insert:',
    '    - id: literature-library',
    `      name: ${yamlQuote(entry)}`,
    '      config:',
    `        workspaceRoot: ${yamlQuote(targetRoot)}`,
    BLOCK_END,
    '',
  ].join('\n');
}

export async function updateProfile(profilePath, transform) {
  await mkdir(dirname(profilePath), { recursive: true });
  const before = existsSync(profilePath) ? await readFile(profilePath, 'utf8') : '';
  let backup = null;
  if (existsSync(profilePath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backup = `${profilePath}.bak-${stamp}`;
    await copyFile(profilePath, backup);
  }
  const after = transform(before);
  await writeFile(profilePath, after, 'utf8');
  return { before, after, backup };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
