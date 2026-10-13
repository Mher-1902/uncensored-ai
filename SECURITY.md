# Security requirements

The current chat product has no accounts, relational database or saved conversations. Its browser and request memory are ephemeral. There are no database tables on which to apply RLS today. Adding persistence requires a separate reviewed data-design change.

## Current boundaries

- Expose the gateway through HTTPS; keep inference, slot administration and monitoring private.
- Validate roles, reply budgets, request size and allowed origins before inference. The client header and CORS rules are request controls; the public chat API is anonymous.
- Erase inference state between requests, stop accepting inference if cleanup fails, and keep slot files on private tmpfs.
- Keep credentials outside Git and frontend assets. Use restricted deployment credentials, pinned host identity, least-privilege workflow permissions and reviewed dependencies.
- Preserve model memory/CPU limits, zero application swap, disabled core dumps and thermal stop behavior. No automatic restart after a thermal shutdown.
- Do not write prompts, replies, screenshots, audio, provider keys or authorization tokens into application logs or metrics.

## RLS before persistent user or tenant data

Every future user/tenant table must have reviewed, default-deny row policies and tests proving isolation for anonymous, owner, other-user and cross-tenant requests. Test read, insert, update and delete, including attempts to transfer ownership. Derive identity from verified authentication, not client-supplied user IDs.

Separate migration ownership from application access. Application roles must not be superusers or have `BYPASSRLS`; apply `FORCE ROW LEVEL SECURITY` where ownership could bypass policy. Privileged backend operations need explicit authorization. Review storage-object policies, views, functions and grants as part of the same boundary. [PostgreSQL row-security documentation](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

These are release requirements for future persistence, not a claim that a database or RLS policies have been deployed.

## Changes and reports

Use a branch and PR, passing CI, a reviewed main commit and the protected production deployment environment. Report a suspected vulnerability through GitHub's private vulnerability reporting when enabled; avoid putting credentials or private user data in public issues.
