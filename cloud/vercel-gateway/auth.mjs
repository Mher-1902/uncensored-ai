import {createRemoteJWKSet, jwtVerify} from 'jose';

export function createVerifier(supabaseUrl, keys) {
  const url = new URL(supabaseUrl);
  if (url.protocol !== 'https:' || !/^[a-z0-9]+\.supabase\.co$/.test(url.hostname) || url.origin !== supabaseUrl) {
    throw Error('SUPABASE_URL must be the exact managed project HTTPS origin.');
  }
  const issuer = `${url.origin}/auth/v1`;
  const jwks = keys || createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {timeoutDuration: 5000});
  return async authorization => {
    if (typeof authorization !== 'string' || authorization.length > 8192 || !/^Bearer [\w.-]+$/i.test(authorization)) throw Error('Invalid session.');
    const {payload} = await jwtVerify(authorization.slice(7), jwks, {
      issuer, audience: 'authenticated', algorithms: ['ES256', 'RS256'], requiredClaims: ['sub', 'exp', 'iat'],
    });
    if (payload.role !== 'authenticated' || payload.is_anonymous === true || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(payload.sub)) {
      throw Error('A signed-in account is required.');
    }
    return payload.sub;
  };
}
