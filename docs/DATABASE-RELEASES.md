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

SQL Editor execution does not establish a Supabase CLI migration-history entry. Before enabling GitHub-driven database deployment or running `supabase db push`, reconcile the exact applied source/hash with the project's migration history using Supabase's supported `supabase migration repair 202610170001 --status applied --linked` workflow, then compare `supabase migration list --linked`. Repair changes history only; it does not apply/revert schema. Never mark the still-unapplied 002 as applied. See [Supabase's migration troubleshooting](https://supabase.com/docs/guides/deployment/database-migrations), checked October 18. Do not re-run this non-idempotent foundation, invent a history record, or edit the applied migration in place. Further schema changes belong in a new migration and need their own tests and release record.

Logical-answer accounting, restricted runtime provisioning, policy/eligibility flows, operator reconciliation, and scheduled metadata retention are still required before account admission is activated.
