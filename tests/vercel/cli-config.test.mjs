import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const gatewayRequire=createRequire(new URL('../../cloud/vercel-gateway/package.json',import.meta.url));
const config=gatewayRequire('@vercel/cli-config');
const configRequire=createRequire(gatewayRequire.resolve('@vercel/cli-config'));

test('gateway pins the patched external Zod dependency without changing its SDK version',()=>{
  assert.equal(configRequire('zod/package.json').version,'4.6.6');
  assert.equal(gatewayRequire('./package.json').dependencies['@vercel/functions'],'3.10.1');
});

test('published CLI config parsers preserve valid config and reject invalid types',()=>{
  const global={credStorage:'file',currentTeam:'fixture-team',telemetry:{enabled:false,future:'kept'},guidance:{enabled:true},updates:{auto:false},future:'kept'};
  assert.deepEqual(config.parseGlobalConfig(global),global);
  for(const value of [{credStorage:'cloud'},{telemetry:{enabled:'yes'}},{updates:{auto:'yes'}}]){
    assert.throws(()=>config.parseGlobalConfig(value));
  }
  const auth={token:'fixture-token',userId:'fixture-user',refreshToken:'fixture-refresh',expiresAt:42,tokenSource:'env',future:'kept'};
  assert.deepEqual(config.parseAuthConfig(auth),auth);
  const {tokenSource,...file}=auth;
  assert.deepEqual(config.parseAuthFileConfig(auth),file);
  for(const value of [{token:123},{expiresAt:'later'},{tokenSource:'other'}])assert.throws(()=>config.parseAuthConfig(value));
  assert.equal(auth.tokenSource,'env');
});
