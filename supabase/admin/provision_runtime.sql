-- Administrator-only, opt-in provisioning. Not an automatic migration.
-- This creates no password and cannot authenticate until the owner completes
-- a separate private password/login setup. Never put credentials in this file.
-- One atomic statement also works with clients using the extended query protocol.
DO $$
BEGIN
  SET LOCAL createrole_self_grant='set,inherit';
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='offscript_runtime') THEN
    RAISE EXCEPTION 'Runtime role already exists; inspect it instead of overwriting';
  END IF;
  CREATE ROLE offscript_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION INHERIT CONNECTION LIMIT 6;
  GRANT offscript_gateway TO offscript_runtime;
  EXECUTE pg_catalog.format('GRANT CONNECT ON DATABASE %I TO offscript_runtime',current_database());
  ALTER ROLE offscript_runtime SET search_path='pg_catalog';
  ALTER ROLE offscript_runtime SET statement_timeout='4s';
  ALTER ROLE offscript_runtime SET lock_timeout='1500ms';
  ALTER ROLE offscript_runtime SET idle_in_transaction_session_timeout='5s';
  COMMENT ON ROLE offscript_runtime IS 'Restricted Offscript SQL API member; no direct tables or owner membership. Credentials configured privately outside source.';
END $$;
