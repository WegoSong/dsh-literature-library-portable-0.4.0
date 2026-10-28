/** Use the host's credential boundary; never patch the shared YAML with regex. */
export function credentialService(ctx) {
  return typeof ctx.get === 'function' ? ctx.get('credentials') : ctx.credentials;
}

export async function resolveHostApiKey(ctx, config, fallback) {
  if (typeof config.apiKey === 'string' && config.apiKey.trim()) {
    return {key: config.apiKey.trim(), source: '配置'};
  }
  const service = credentialService(ctx);
  if (service?.resolve) {
    const hit = await service.resolve('DEEPSEEK_API_KEY');
    // A running host is authoritative: do not revive a stale foreign top-level key.
    return {key: hit?.value || null, source: hit ? 'DSH 凭据服务' : null};
  }
  return fallback(config);
}

export async function storeHostApiKey(ctx, key) {
  const service = credentialService(ctx);
  if (!service?.set || !service?.resolve) {
    throw Object.assign(new Error('当前 DSH 未提供凭据写入服务，请在 DSH「模型」设置中保存 API key；插件不会直接改写登录凭据文件'), {status: 503});
  }
  await service.set('DEEPSEEK_API_KEY', key);
  const hit = await service.resolve('DEEPSEEK_API_KEY');
  if (hit?.value !== key) throw new Error('DSH 凭据服务回读校验失败');
  return {file: 'DSH 凭据服务（refs.DEEPSEEK_API_KEY）', backup: null};
}
