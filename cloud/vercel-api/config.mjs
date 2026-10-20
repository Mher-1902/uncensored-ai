// Publish only the browser-safe key. Privileged and legacy JWT keys are excluded.
export function publicConfig(metadata, env = process.env) {
  let auth = null;
  try {
    const url = new URL(env.SUPABASE_URL);
    if (url.origin === env.SUPABASE_URL && url.protocol === 'https:' && /^[a-z0-9]+\.supabase\.co$/.test(url.hostname)
      && /^sb_publishable_[A-Za-z0-9_-]{16,256}$/.test(env.SUPABASE_PUBLISHABLE_KEY || '')) {
      const providers = [...new Set((env.SUPABASE_AUTH_PROVIDERS || '').split(',').map(value => value.trim()).filter(value => ['google', 'github'].includes(value)))];
      auth = {url: url.origin, publishableKey: env.SUPABASE_PUBLISHABLE_KEY, providers, emailEnabled: env.SUPABASE_EMAIL_ENABLED === 'true'};
    }
  } catch {}
  return {model: metadata.model, modelUrl: metadata.modelUrl, space: null, apiBase: '/api', requireAuth: true, auth,
    ...(['512','768'].includes(env.FAST_REPLY_TOKENS) ? {fastReplyTokens:Number(env.FAST_REPLY_TOKENS)} : {}),
    ...(env.PILOT_ACCOUNT_CONTROL === 'true' ? {accountControl: true} : {})};
}
