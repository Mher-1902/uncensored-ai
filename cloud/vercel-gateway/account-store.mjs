const faults = {
  account_restricted: [403, 'Your account is waiting for pilot access.'],
  eligibility_required: [403, 'Account eligibility must be confirmed before using the pilot.'],
  acceptance_required: [403, 'Please review and accept the current policies.'],
  policy_changed: [409, 'The policies changed. Please review the current versions.'],
  policy_unavailable: [503, 'The service policies are not published yet.'],
  quota_exceeded: [429, 'Your daily allowance has been reached.'],
  request_in_progress: [429, 'Your account already has a request in progress.'],
  capacity_busy: [429, 'The server is at capacity. Please try again later.'],
};
export class AccountError extends Error {
  constructor(code = 'account_unavailable') {
    const [status, message] = faults[code] || [503, 'Account controls are temporarily unavailable. Please try again.'];
    super(message); this.code = faults[code] ? code : 'account_unavailable'; this.status = status;
  }
}
export function accountFailure(error) {
  return error instanceof AccountError ? error : new AccountError();
}
export function accountControlEnabled(env) {
  if (env.PILOT_ACCOUNT_CONTROL && !['true', 'false'].includes(env.PILOT_ACCOUNT_CONTROL)) throw new AccountError();
  return env.PILOT_ACCOUNT_CONTROL === 'true';
}

export function databaseOptions(env) {
  try {
    const url = new URL(env.PILOT_DATABASE_URL);
    const user = decodeURIComponent(url.username);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search || url.hash || url.pathname !== '/postgres'
      || !/^(?:db\.[a-z0-9]+\.supabase\.co|[a-z0-9-]+\.pooler\.supabase\.com)$/.test(url.hostname)
      || !['', '5432', '6543'].includes(url.port) || !/^offscript_runtime(?:\.[a-z0-9]+)?$/.test(user) || !url.password) throw Error();
    return {host: url.hostname, port: Number(url.port || 5432), database: 'postgres', user, password: decodeURIComponent(url.password),
      ssl: {rejectUnauthorized: true, ...(env.PILOT_DATABASE_CA ? {ca: env.PILOT_DATABASE_CA} : {})},
      max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, maxLifetimeSeconds: 60,
      statement_timeout: 4000, lock_timeout: 1500, query_timeout: 5000, allowExitOnIdle: true};
  } catch { throw new AccountError(); }
}

// The pool is lazy; a disabled deployment never opens a database connection.
export function createAccountStore({env = process.env, poolFactory} = {}) {
  let initialized;
  async function pool() {
    if (!initialized) initialized = (async () => {
      const options = databaseOptions(env);
      const make = poolFactory || (async config => {const {Pool} = await import('pg'); return new Pool(config);});
      const value = await make(options);
      // Prevent idle connection errors from becoming an unhandled process error.
      value.on('error', () => {});
      try {
        const {rows} = await value.query(`SELECT current_user AS name, NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication)
          AND pg_has_role(current_user,'offscript_gateway','MEMBER')
          AND NOT pg_has_role(current_user,'offscript_data_owner','MEMBER') AS restricted
          FROM pg_roles r WHERE r.rolname=current_user`);
        if (rows.length !== 1 || rows[0].name !== 'offscript_runtime' || rows[0].restricted !== true) throw new AccountError();
        return value;
      } catch (error) {await value.end().catch(() => {}); throw error;}
    })().catch(error => {initialized = undefined; throw accountFailure(error);});
    return initialized;
  }
  async function call(sql, values) {
    try {
      const {rows} = await (await pool()).query(sql, values);
      if (rows.length !== 1 || !rows[0].result || typeof rows[0].result !== 'object') throw new AccountError();
      return rows[0].result;
    } catch (error) {
      if (error.code === 'P0001' && Object.hasOwn(faults, error.message)) throw new AccountError(error.message);
      throw accountFailure(error);
    }
  }
  return {
    account: user => call('SELECT offscript_api.account($1::uuid) AS result', [user]),
    accept: (user, terms, privacy) => call('SELECT offscript_api.accept_policies($1::uuid,$2::text,$3::text) AS result', [user, terms, privacy]),
    reserve: (user, request, mode, maxTokens) => call('SELECT offscript_api.reserve_request($1::uuid,$2::uuid,$3::text,$4::integer) AS result', [user, request, mode, maxTokens]),
    finish: (user, request, outcome, promptTokens, completionTokens, workerStopped) => call('SELECT offscript_api.finish_request($1::uuid,$2::uuid,$3::text,$4::integer,$5::integer,$6::boolean) AS result', [user, request, outcome, promptTokens, completionTokens, workerStopped]),
  };
}
