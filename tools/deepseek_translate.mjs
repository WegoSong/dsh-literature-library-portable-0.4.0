/**
 * deepseek_translate.mjs —— 直连 DeepSeek API 的翻译实现。
 *
 * 为什么不用 agent 会话：插件早先是「创建翻译会话 + 投递提示词」，但那套机制
 * （`ctx.agents.create()` + `followup`）行为不透明——实测会话建起来了、
 * 接口返回 200，但日志里永远只有一个会话头事件，提示词从未被接受。
 * 排查多轮未果后改为直连 API：路径短、可控、进度可观测。
 *
 * 端点：DeepSeek 的 **Anthropic 兼容** Messages API
 * （与 DSH 自己的 `dsh-llm-deepseek` provider 用同一端点，见其 `PUBLIC_BASE_URL`）。
 * 鉴权头 `x-api-key` + `anthropic-version`。
 *
 * API key 来源（按优先级）：
 *   1. `config.apiKey`
 *   2. 环境变量 `DEEPSEEK_API_KEY`
 *   3. `$DSH_HOME/.credentials.yaml` 里的 `DEEPSEEK_API_KEY`（DSH 自己的凭据文件）
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {blockPayload} from './block_transport.mjs';

export const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic';
export const DEFAULT_MODEL = 'deepseek-flash';
export const DEFAULT_MAX_TOKENS = 32000;

const REASONING_EFFORTS = new Set(['none', 'low', 'high', 'max']);
const DEFAULT_REASONING_RESERVE = Object.freeze({
  none: 0,
  low: 2048,
  high: 8192,
  max: 16000,
});

/**
 * 把不同调用方使用的「是否思考」参数统一成 DeepSeek 的 effort。
 *
 * `reasoningEffort` 是首选参数；`effort`、`thinking` 是兼容别名。翻译任务
 * 默认关闭思考，避免模型生成随后会被丢弃、但仍然计费的 thinking token。
 */
export function resolveReasoningEffort({ reasoningEffort, effort, thinking } = {}) {
  let value = reasoningEffort ?? effort;

  if (value == null) {
    if (typeof thinking === 'string') value = thinking;
    else if (thinking && typeof thinking === 'object') {
      value = thinking.effort
        ?? (thinking.type === 'enabled' ? 'low' : thinking.type === 'disabled' ? 'none' : null);
    } else if (thinking === true) value = 'low';
    else value = 'none';
  }

  if (value === false || value === 'off' || value === 'disabled') value = 'none';
  if (value === true || value === 'on' || value === 'enabled') value = 'low';
  const normalized = String(value).trim().toLowerCase();
  if (!REASONING_EFFORTS.has(normalized)) {
    throw new TypeError(`不支持的 reasoningEffort：${value}（可用 none/low/high/max）`);
  }
  return normalized;
}

/**
 * 解析输出 token 上限。
 *
 * 旧调用可继续传数字；需要按块动态设定时可传 `"auto"`，或传：
 * `{ min, max, inputRatio, base, reasoningReserve }`。动态值只限制异常输出，
 * API 仍然按实际 token 计费。
 */
export function resolveMaxTokens(maxTokens = DEFAULT_MAX_TOKENS, {
  user = '',
  reasoningEffort = 'none',
} = {}) {
  if (typeof maxTokens === 'number') {
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
      throw new TypeError(`maxTokens 必须是正数，收到：${maxTokens}`);
    }
    return Math.max(1, Math.floor(maxTokens));
  }

  if (typeof maxTokens === 'function') {
    const estimatedInputTokens = estimateTokens(user);
    return resolveMaxTokens(maxTokens({ estimatedInputTokens, reasoningEffort }), {
      user,
      reasoningEffort,
    });
  }

  if (maxTokens !== 'auto' && (!maxTokens || typeof maxTokens !== 'object')) {
    throw new TypeError('maxTokens 必须是正数、"auto"、自动配置对象或计算函数');
  }

  const config = maxTokens === 'auto' ? {} : maxTokens;
  const min = Number(config.min ?? config.minTokens ?? 2048);
  const max = Number(config.max ?? config.maxTokens ?? DEFAULT_MAX_TOKENS);
  const inputRatio = Number(config.inputRatio ?? config.ratio ?? 1.5);
  const base = Number(config.base ?? config.baseTokens ?? 768);
  const reserveSetting = config.reasoningReserve ?? config.reasoningReserveTokens;
  const reserve = Number(
    reserveSetting && typeof reserveSetting === 'object'
      ? reserveSetting[reasoningEffort] ?? DEFAULT_REASONING_RESERVE[reasoningEffort]
      : reserveSetting ?? DEFAULT_REASONING_RESERVE[reasoningEffort],
  );

  if (![min, max, inputRatio, base, reserve].every(Number.isFinite)
      || min <= 0 || max < min || inputRatio <= 0 || base < 0 || reserve < 0) {
    throw new TypeError('maxTokens 自动配置无效：需要 0 < min <= max、inputRatio > 0，且 base/reserve >= 0');
  }

  const estimated = Math.ceil(estimateTokens(user) * inputRatio + base + reserve);
  return Math.floor(Math.min(max, Math.max(min, estimated)));
}

function tokenCount(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const count = Number(value);
    if (Number.isFinite(count) && count >= 0) return Math.floor(count);
  }
  return null;
}

/**
 * 统一 DeepSeek 原生、Anthropic 兼容层和 OpenAI 风格的 usage 字段。
 * 未识别字段会原样保留，便于以后兼容服务端新增的统计项。
 */
export function normalizeUsage(rawUsage, { reasoningEffort = 'none' } = {}) {
  if (!rawUsage || typeof rawUsage !== 'object') return null;

  const inputTokens = tokenCount(rawUsage.input_tokens, rawUsage.prompt_tokens);
  const outputTokens = tokenCount(rawUsage.output_tokens, rawUsage.completion_tokens);
  const cacheHitTokens = tokenCount(
    rawUsage.prompt_cache_hit_tokens,
    rawUsage.cache_read_input_tokens,
    rawUsage.prompt_tokens_details?.cached_tokens,
    rawUsage.input_tokens_details?.cache_read_tokens,
    rawUsage.input_tokens_details?.cached_tokens,
  );
  const cacheMissTokens = tokenCount(
    rawUsage.prompt_cache_miss_tokens,
    rawUsage.cache_creation_input_tokens,
    rawUsage.prompt_tokens_details?.cache_miss_tokens,
    rawUsage.input_tokens_details?.cache_miss_tokens,
  );
  const reportedThinkingTokens = tokenCount(
    rawUsage.thinking_tokens,
    rawUsage.output_tokens_details?.thinking_tokens,
    rawUsage.completion_tokens_details?.thinking_tokens,
  );
  const reportedReasoningTokens = tokenCount(
    rawUsage.reasoning_tokens,
    rawUsage.output_tokens_details?.reasoning_tokens,
    rawUsage.completion_tokens_details?.reasoning_tokens,
    reportedThinkingTokens,
  );
  const reasoningTokens = reportedReasoningTokens
    ?? (reasoningEffort === 'none' ? 0 : null);
  const thinkingTokens = reportedThinkingTokens ?? reasoningTokens;

  return {
    ...rawUsage,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    prompt_cache_hit_tokens: cacheHitTokens,
    prompt_cache_miss_tokens: cacheMissTokens,
    reasoning_tokens: reasoningTokens,
    thinking_tokens: thinkingTokens,
  };
}

/** DSH home（与插件其它部分保持同一套规则） */
function dshHome() {
  const h = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  return h;
}

/**
 * 从 DSH 的凭据文件里取 API key。
 * 文件是 YAML，但我们只需要其中一个简单键值，用一个针对性正则即可，
 * 不为此引入 YAML 依赖（解析整份 YAML 也不安全——里面还有别的东西）。
 */
async function keyFromCredentialsFile() {
  const file = join(dshHome(), '.credentials.yaml');
  if (!existsSync(file)) return null;
  let text;
  try { text = await readFile(file, 'utf8'); } catch { return null; }
  // 只匹配 `DEEPSEEK_API_KEY: sk-...`
  const m = /(?:^|\n)\s*DEEPSEEK_API_KEY\s*:\s*['"]?([A-Za-z0-9_\-]{10,})['"]?\s*(?:\n|$)/.exec(text);
  return m ? m[1] : null;
}

/**
 * 解析 API key。
 * @returns `{ key, source }`；找不到时 `key` 为 null。
 */
export async function resolveApiKey(config = {}) {
  if (typeof config.apiKey === 'string' && config.apiKey.trim() !== '') {
    return { key: config.apiKey.trim(), source: '配置' };
  }
  const env = process.env.DEEPSEEK_API_KEY;
  if (typeof env === 'string' && env.trim() !== '') {
    return { key: env.trim(), source: '环境变量 DEEPSEEK_API_KEY' };
  }
  const fromFile = await keyFromCredentialsFile();
  if (fromFile) return { key: fromFile, source: `${join(dshHome(), '.credentials.yaml')}` };
  return { key: null, source: null };
}

/**
 * 调用 Messages API（非流式）。
 *
 * @param opts.baseUrl - 端点根（默认 `https://api.deepseek.com/anthropic`）
 * @param opts.apiKey - 密钥
 * @param opts.model - 模型 id
 * @param opts.system - 系统提示词
 * @param opts.user - 用户内容
 * @param opts.maxTokens - 输出上限数字，或 `"auto"` / 自动配置对象 / 计算函数
 * @param opts.reasoningEffort - `none`（默认）、`low`、`high` 或 `max`
 * @param opts.effort - `reasoningEffort` 的兼容别名
 * @param opts.thinking - 是否启用思考的兼容参数
 * @param opts.timeoutMs - 单次请求超时
 * @param opts.signal - 取消信号
 * @returns `{ text, usage }`
 */
export async function callDeepSeek({
  baseUrl = DEFAULT_BASE_URL,
  apiKey,
  model = DEFAULT_MODEL,
  system,
  user,
  maxTokens = DEFAULT_MAX_TOKENS,
  reasoningEffort,
  effort,
  thinking,
  timeoutMs = 300000,
  signal,
} = {}) {
  const url = `${String(baseUrl).replace(/\/+$/u, '')}/v1/messages`;
  const resolvedReasoningEffort = resolveReasoningEffort({ reasoningEffort, effort, thinking });
  const resolvedMaxTokens = resolveMaxTokens(maxTokens, {
    user,
    reasoningEffort: resolvedReasoningEffort,
  });
  /*
   * 兜底：API 要求 max_tokens 是 u32。调用方可以传对象（按块动态计算），
   * 但这里必须已经换算成整数；一旦不是，就在本地报出可读错误，
   * 而不是让服务端返回 422 "invalid type: map" 这种难懂的信息。
   * （0.6.0 的安装包曾误把旧版工具打进插件，旧版不做换算，正好触发了这条。）
   */
  if (!Number.isInteger(resolvedMaxTokens) || resolvedMaxTokens <= 0) {
    throw new TypeError(
      `max_tokens 必须是正整数，收到 ${JSON.stringify(resolvedMaxTokens)}；`
      + '请检查 resolveMaxTokens 是否被旧版工具脚本覆盖。',
    );
  }
  const thinkingConfig = resolvedReasoningEffort === 'none'
    ? { thinking: { type: 'disabled' } }
    : {
        thinking: { type: 'enabled' },
        output_config: { effort: resolvedReasoningEffort },
      };
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: resolvedMaxTokens,
        system,
        messages: [{ role: 'user', content: user }],
        ...thinkingConfig,
      }),
    });

    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { /* 保留原文用于报错 */ }

    if (!res.ok) {
      const msg = data?.error?.message ?? data?.message ?? raw.slice(0, 300);
      throw new Error(`DeepSeek API ${res.status}：${msg}`);
    }

    /*
     * 解析返回内容：**只取 `text` 块，丢掉 `thinking`**。
     *
     * `deepseek-flash` 是会推理的模型，`content` 里通常先有
     * `{ type: 'thinking' }`（推理过程）再有 `{ type: 'text' }`（正式回答）。
     * 推理过程不是译文，混进去会污染输出；所以过滤掉。
     *
     * 但要注意一个陷阱：若 max_tokens 太小，token 会被推理吃光，
     * 响应里**只有 thinking**、没有 text。此时不能报「没有内容」就完事——
     * 那会让人以为是别的问题。这里给出明确的「把 maxTokens 调大」提示。
     */
    const blocks = Array.isArray(data?.content) ? data.content : [];
    const text = blocks
      .filter((c) => c?.type === 'text')
      .map((c) => c.text ?? '')
      .join('');
    const thinkingChars = blocks
      .filter((c) => c?.type === 'thinking')
      .map((c) => c.thinking ?? '')
      .join('').length;

    if (!text.trim()) {
      if (data?.stop_reason === 'max_tokens') {
        /*
         * 输出预算被用完（思考或正文）。这不是「数据坏了」，而是「这一档
         * max_tokens 不够」，调用方应当加大预算重试同一块，而不是让整篇失败。
         * 因此带上 code，便于 index.js 区分处理。
         */
        const error = new Error(
          `输出预算用完，没有正文（推理 ${thinkingChars} 字；当前 maxTokens=${resolvedMaxTokens}）。`,
        );
        error.code = 'max_tokens';
        error.thinkingChars = thinkingChars;
        error.maxTokens = resolvedMaxTokens;
        // 这一次请求仍然计费，把 usage 带出去让任务统计能算准
        error.usage = normalizeUsage(data?.usage, { reasoningEffort: resolvedReasoningEffort });
        throw error;
      }
      throw new Error(`API 返回里没有正文（stop_reason=${data?.stop_reason ?? '?'}）`);
    }
    return {
      text,
      thinkingChars,
      usage: normalizeUsage(data?.usage, { reasoningEffort: resolvedReasoningEffort }),
      truncated: data?.stop_reason === 'max_tokens',
      stopReason: data?.stop_reason ?? null,
      reasoningEffort: resolvedReasoningEffort,
      maxTokens: resolvedMaxTokens,
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** 粗略估算 token 数：中文按 1 字 ≈ 1 token，英文按 4 字符 ≈ 1 token */
export function estimateTokens(text) {
  const s = String(text ?? '');
  const cjk = (s.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g) ?? []).length;
  const rest = s.length - cjk;
  return Math.ceil(cjk + rest / 4);
}

/**
 * 把长文本切成若干块，尽量在段落/句子边界切。
 *
 * 为什么要分块：整篇论文动辄上万字，一次请求容易超过上下文或输出上限；
 * 分块还能让进度显示成 `3/7` 这样的真实进度。
 *
 * @param text - 全文
 * @param maxTokensPerChunk - 每块的目标 token 上限
 * @returns 文本块数组
 */
export function chunkText(text, maxTokensPerChunk = 3000) {
  const s = String(text ?? '').replace(/\r\n/g, '\n');
  if (s.trim() === '') return [];

  // 先按空行切成段落，再贪心合并到接近上限
  const paras = s.split(/\n{2,}/);
  const chunks = [];
  let buf = [];
  let bufTokens = 0;

  const flush = () => {
    if (buf.length) chunks.push(buf.join('\n\n'));
    buf = [];
    bufTokens = 0;
  };

  for (const p of paras) {
    const t = estimateTokens(p);
    if (t > maxTokensPerChunk) {
      // 单段就超限：按句子再切
      flush();
      const sentences = p.split(/(?<=[。！？；.!?;])\s*/u);
      let sbuf = [];
      let st = 0;
      for (const sent of sentences) {
        const stk = estimateTokens(sent);
        if (st + stk > maxTokensPerChunk && sbuf.length) {
          chunks.push(sbuf.join(''));
          sbuf = [];
          st = 0;
        }
        sbuf.push(sent);
        st += stk;
      }
      if (sbuf.length) chunks.push(sbuf.join(''));
      continue;
    }
    if (bufTokens + t > maxTokensPerChunk) flush();
    buf.push(p);
    bufTokens += t;
  }
  flush();
  return chunks;
}

/**
 * 翻译任务的系统提示词：把用户的九条硬性要求固化为可复用的指令。
 *
 * 这段文字会随每一块发送，但**不要为了省 token 删减约束**。实测 DeepSeek 的
 * 自动前缀缓存会命中这段相同前缀（缓存价约为未命中的 1/50），压缩措辞每块只省
 * 几十个 token，却可能让模型漏掉某条硬性要求，得不偿失。
 */
export function buildSystemPrompt({ roleHint, extraRules } = {}) {
  const role = roleHint
    || '你是一位专业的热物性/传感器/自供电/机械/材料/热物理/计算机等方向的人员。';
  return [
    role,
    '你的任务是把用户给你的学术论文内容准确翻译成规范的中文。',
    '',
    '硬性要求：',
    '1. 准确翻译所有专有名词、术语、人名、地名及引用标记；如果无法翻译，',
    '   在它前面和后面加 * 号并且不改变原文。',
    '2. 保持中心思想不变。',
    '3. 输出时不要保留原有的一页双栏格式，改为正常的中文论文格式。',
    '4. 遇到图片只需保留图片的标注并翻译它，跳过图片内容本身。',
    '5. 参考文献列表已由程序在本地剥离；正文里的引用保护标记必须原样保留。',
    '6. 由于页面划分而被截断的段落，要连通后翻译。',
    '7. 保留文献中的上下标和物理符号格式。',
    '8. 公式必须用 LaTeX 表示，并确保可以被 KaTeX 正确渲染：',
    '   行内公式用 $...$，独立公式用 $$...$$；不要输出图片形式的公式。',
    '9. 只输出译文本身，不要加任何说明、前言、道歉或「以下是翻译」之类的话。',
    '10. 出版元数据由程序在本地生成，不要自行添加题名、作者、期刊、日期或 DOI 头部。',
    '11. `[原文第 n 页]` 与 `[本页版面：n 栏]` 仅用于恢复阅读顺序，不要出现在最终译文。',
      '12. @@DSH_BLOCK_nnnnnn@@ 是原文段落/标题边界。每个标记必须恰好出现一次，顺序不变。',
      '    每个标记后的内容只翻译该原段落，不与别段合并、不拆段、不调换顺序；标题保留 Markdown # 层级和编号。',
      '13. @@DSH_FORMULA_nnnnnn@@ 也可能代表原 PDF 公式截图，必须放在原段落位置，绝不自行重写或补写该公式。',
    '',
    // 这一段是**实测踩坑后补的**：批量翻译的译文里有 6 条公式渲染失败，
    // 全部是「反斜杠被吃掉」造成的——`\cdot` 变成了中点字符 U+00B7、
    // `\,` 变成了垂直制表符 U+000B（JS 把 `\v` 当转义）、`Te_3_` 连用两个下划线。
    // 这类损坏**在译文里看不出来**，只在 KaTeX 渲染时才炸，所以必须在提示词里禁止。
    '★ LaTeX 书写要求（极重要，写错会让公式直接渲染失败）：',
    '- 反斜杠必须原样保留**一个**：\\frac、\\eta、\\mathrm、\\text、\\pi 都要带反斜杠。',
    '  绝不可以用 Unicode 字符替代命令（例如把 \\cdot 写成中点字符 ·）。',
    '- 间距命令只允许：\\, \\; \\: \\! \\quad \\qquad。不要使用 \\cdotp 这类生僻命令；',
    '  中点请写 \\cdot 或 \\text{·}。',
    '- 同一层不要连用两个下标或上标：正确 $a_b^c$、$\\mathrm{Bi_2Te_3}$；',
    '  错误如 $X_2_3$、$\\mathrm{Bi_2Te_3_{2}}$。',
    '- 度数写 $^\\circ$ 或 \\text{°}，且 ^ 前面不要紧跟间距命令：',
    '  推荐 $(20 \\pm 5)^\\circ\\mathrm{C}$ 或 $(20 \\pm 5)\\,{}^\\circ\\mathrm{C}$。',
    '- 不要用 Unicode 上下标字符（⁻¹、₂ 等），一律用 ^ 与 _。',
    '- 抽取结果里已经放在 `$$...$$` 中的公式，除非只是补空格或规范上下标，否则原样保留；',
    '  不翻译变量、不改变等号两边结构、不凭上下文重新推导。复杂公式不确定时保留原始字符并标注核对。',
    '- 双栏页必须按抽取文本给出的顺序处理，绝不能把左右栏同一高度的两句话拼成一句。',
    '',
    '格式要求：',
    '- 直接用 Markdown；标题用 # / ## / ###；',
    '- 表格用 Markdown 表格；图注、表注保留并翻译；',
    '- 如果某处公式在原文里被抽取工具拆坏了、无法确定结构，',
    '  请在该公式后另起一行标注「**请以原文核对**」，**绝不要编造公式**。',
    extraRules ?? '',
  ].filter(Boolean).join('\n');
}

/** 单块的用户提示词 */
export function buildUserPrompt({ chunk, index, total, title, source, structured=false }) {
  return [
    `文献：《${title ?? source}》`,
      '请逐段准确翻译下面的正文片段；按原顺序保留段落、标题层级和编号，逐字保留所有 @@DSH_*@@ 保护标记，每个恰好一次。',
    total > 1 ? `片段：${index + 1} / ${total}` : '',
    structured ? '本次原文为 JSON blocks 数组。逐个翻译 text，返回 {"blocks":[{"id":"原编号","text":"完整译文"}]}。id 必须完整且不重复；不要输出 @@DSH_BLOCK@@ 边界，由程序重建。text 中其他保护标记必须原样保留，标题保留 # 层级。' : '',
    '',
    '----- 原文开始 -----',
    structured ? JSON.stringify(blockPayload(chunk)) : chunk,
    '----- 原文结束 -----',
  ].filter(Boolean).join('\n');
}
