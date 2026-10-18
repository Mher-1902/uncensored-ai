# Database release record

## Foundation — October 17, 2026

The owner explicitly approved applying `202610170001_pilot_accounts.sql` to the existing Supabase project `pgyfliwdlonitlhzmmsj`. It was executed through that project's SQL Editor after the provider-compatible migration passed both disposable database fixtures and all PR #27 checks, including the Docker workflow.

- Source: commit `64302f6`, PR https://github.com/Mher-1902/uncensored-ai/pull/27.
- Migration SHA-256: `fd6f562fc9a9e8d1d084fcd4bb1cef142f4530a3bc2d91626c90ecadb431ac51`.
- SQL Editor result: `Success. No rows returned` after the transaction committed.
- Eleven subsequent metadata-only checks passed: five owner-controlled forced-RLS tables; two limited NOLOGIN roles; temporary schema CREATE removed; three own-record SELECT policies; authenticated SELECT-only access; no anonymous table access; no gateway direct table access; private schemas unavailable to clients; five limited SECURITY DEFINER functions; draft policies unpublished; runtime login absent.
- Local execution and verification screenshots are retained in the task's `outputs/rls-foundation-{applied,verified}-20261017.png` artifacts. They contain schema/check metadata, not account contents.

This installs the foundation only. `PILOT_ACCOUNT_CONTROL` remains off. No runtime password/database URL was created, account eligibility enabled, draft policy published, or chat storage added. The current production website and inference path remain usable.

### Migration history gate

SQL Editor execution did not establish a Supabase CLI migration-history entry. This gate was reconciled with the official CLI on October 18, before deploying migration 002; see the records below. Supabase's supported `migration repair` changes history only and must never be used to label an uninstalled migration as applied. See [Supabase's migration troubleshooting](https://supabase.com/docs/guides/deployment/database-migrations), checked October 18. Do not re-run this non-idempotent foundation, invent a history record, or edit an applied migration in place. Further schema changes belong in a new migration and need their own tests and release record.

At the foundation release, logical-answer accounting and restricted runtime provisioning were still pending. Their database components are now installed as recorded below; credential activation, protocol-5 deployment, policy/eligibility flows, operator reconciliation and scheduled metadata retention remain required before account admission is activated.

## Maintenance preparation — October 18, 2026

The official Supabase CLI 2.121.0 was installed in a separate versioned user-local directory on the Samsung. The official Linux archive SHA-256 was verified as `4b481189efbdc57cf2d37bdee5f1a0d29574314398564b32a6dfb76c0fcf275f`; no existing tool or serving service was replaced. The owner entered the project database password in a private masked Terminal prompt; it was neither returned to the agent nor persisted by the helper.

The official `migration repair 202610170001 --status applied --db-url <password-free verified-TLS session URL>` operation completed at 20:19 Riga time (17:19 UTC). The helper first verified the administrator identity, five installed forced-RLS owner tables, two NOLOGIN roles, unpublished policies and absent logical-answer/runtime objects. It then verified that remote history contained exactly foundation version `202610170001`/`pilot_accounts`, with statements retained, and compared the official local/remote migration list. Version 002 was pending at this checkpoint. Supabase's Database Migrations page independently showed the same sole foundation entry; evidence is retained in the task's `outputs/supabase-history-repaired-20261018.png`. This repaired the foundation history gate only; it did not execute the foundation again or authorize/apply a later schema release or activate admission.

The project's dashboard supplies the public [Supabase CA certificate](https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt), SHA-256 `700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7`. The Paris session pooler's certificate chain and hostname were verified from the Samsung using this CA. Maintenance uses port 5432 with `sslmode=verify-full`; the pooler avoids needing a paid IPv4 add-on. Credentials must remain private, and this administrator connection must never become the application's runtime URL.

The opt-in `supabase/admin/provision_runtime.sql` was prepared separately from automatic migrations. It creates only a restricted, password-free NOLOGIN role and refuses to overwrite an existing role. The final atomic script passed 69 managed-project database checks plus four combined client/bridge/native/SQL cases in the isolated Samsung fixture, peak 59°C. A separate offline rehearsal exercised the official CLI itself: foundation history repair, an exact 002-only dry-run, actual 002 deployment/history update, runtime provisioning and the final metadata verification/list all passed, peak 58°C. This rehearsal caught the CLI's rejection of multi-statement query files; provisioning uses one atomic DO statement. Six regression checks are now captured in PR #32 and passed both locally and in GitHub CI. All required checks for PRs #31 and #32 passed, including Docker.

## Logical-answer ledger and NOLOGIN runtime — October 18, 2026

The owner explicitly approved both changes. Using the checksum-verified CLI and a privately entered project database password, the release completed at 21:08 Riga time (18:08 UTC). The CLI verified the exact foundation-only starting state, confirmed a 002-only dry-run, applied migration 002 with its history entry, and executed the opt-in runtime provisioning script. The helper's final metadata verification passed. It did not save the password or create a runtime password.

- Approved source: `0d0939231ca2579b169bb3bc940cf21bcec60987`, PR #31; ledger implementation in PR #29.
- `202610170002_logical_answers.sql` SHA-256: `7de0e2b762fdc5e5402267d97b4b335005cd0fc9b46eae2a952cfcb4053756e6`.
- `supabase/admin/provision_runtime.sql` SHA-256: `8a86b4b5aee9b424896436a78b581cf64fd87a202ca420f438796274ba1e5a6f`.
- Supabase independently lists exactly `202610170001 / pilot_accounts` and `202610170002 / logical_answers`.
- Eleven metadata-only live checks returned true: exact history; seven forced-RLS owner tables; restricted NOLOGIN runtime; sole gateway membership; no direct runtime table access; legacy admission disabled; five logical-answer functions available; client-blocked private schemas; deletion guard enabled; unpublished policies; bounded runtime settings.
- Evidence is retained in the task's `outputs/ledger-migrations-applied-20261018.png`, `ledger-live-verified-20261018.png`, `ledger-live-checks-20261018.txt` and the read-only verification SQL. The owner-run status is `/home/rog/dev/maintenance/ledger-release-20261018-2/status.json`.

Post-release website health returned ready with native protocol 4, no queued/active inference and required sign-in. Public configuration confirms account enforcement remains off. No serving image/model, runtime login/password, policy publication or eligibility activation was changed. The database installation is complete; the protocol-5 application rollout, private runtime credential activation and remaining recovery/retention/policy gates are separate work.
