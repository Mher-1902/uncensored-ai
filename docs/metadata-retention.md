# Private metadata retention command

Prepared October 19, 2026. This source increment adds no schema, credential, public API or active schedule. The installed `offscript_runtime` remains NOLOGIN. Account enforcement and policy publication remain off.

`scripts/prune-metadata.mjs` reuses the gateway's strict restricted-role connection validation, managed Supabase host allowlist, certificate/hostname verification and bounded database timeouts. It takes no connection arguments and prints no URL, password, row contents or provider diagnostics. The existing `PILOT_DATABASE_URL` and optional public `PILOT_DATABASE_CA` are operator-managed environment configuration; never use the administrator login as the scheduled application's connection.

With no argument or `--check`, the command only validates configuration offline. It does not load PostgreSQL dependencies, resolve DNS, connect, inspect rows or prune anything. An unset/invalid connection fails with a fixed message; it never prompts for a password. A successful configuration check proves no live connectivity or role permissions.

Only explicit `--apply` opens a one-connection pool. It verifies that the connected identity is exactly the restricted `offscript_runtime`, has the gateway group without owner/administrative privileges, and may execute the installed retention function. It then runs only `SELECT offscript_api.prune_metadata()`. No private table SELECT grants, new SQL function or public maintenance endpoint is needed. Success means the function completed; it does not report invented deletion counts or prove there was data to remove.

## Existing retention boundary

Migration 002 owns the actual rules: expire only known-stopped waiting handoffs; remove finished answer/segment and legacy request metadata after 24 hours; remove daily usage aggregates older than 35 days unless open/uncertain work still needs them. Active or uncertain computation remains reserved even after its deadline. The command cannot reconcile that work, approve eligibility, publish policies, delete an Auth account, or prove an old model process stopped.

The existing deletion guard blocks an Auth/account cascade while an answer or legacy lease remains open. Operator recovery still needs actual stop proof for both affected gateway and model processes/cgroups before settlement. A restarted gateway, an old timestamp or a successful retention run is not that proof. Keep these separate gates in [ACCOUNT-CONTROL.md](ACCOUNT-CONTROL.md).

## Validation and later activation

`tests/metadata-retention.test.mjs` checks offline/default behavior, restricted connection rules, fixed-query execution, privilege rejection and redacted failures using injected dummy pools. The parent-run `scripts/test-metadata-retention.mjs` accepts only a marked disposable loopback PostgreSQL fixture with hardcoded dummy credentials. Run it after migrations 001/002 and the NOLOGIN test role exist in the isolated fixture. It checks that offline validation leaves rows intact, then exercises the actual command as the restricted role: old finished records and daily totals are removed while equally old active/uncertain records and reservations remain. Its fixture changes are rolled back. These are test instructions, not evidence that this new increment has passed validation yet.

The `.service.example` and `.timer.example` files are inert templates. No installer, startup hook or workflow enables them. Before a later activation, use an immutable reviewed release with installed gateway dependencies, verify the Samsung's Node/systemd paths and sandbox support, provision restricted authentication privately and place its environment file outside Git with owner-only permissions. Keep its URL out of process arguments and logs. Review distribution of this database credential to the scheduler host separately from Vercel.

The example runs hourly with a small CPU/memory allowance and a 30-second wall bound. Actual deletion can therefore occur on the next successful run after the SQL threshold, rather than exactly at 24 hours or 35 days. A stopped host or failed job delays cleanup; verify the active timer and successful invocations before publishing a retention promise. Do not enable the example while runtime login remains disabled, mark this source as a running cleanup service, or claim recovery/account deletion is finished.
