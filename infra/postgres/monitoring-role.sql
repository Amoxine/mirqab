-- Monitoring login role for postgres-exporter (OG-OBS-02, docs/ha-observability/01 §6).
-- Run by the `pg-monitoring-init` one-shot in infra/docker-compose.yml on every `up`, as the
-- opengateway superuser, with PG_EXPORTER_PASSWORD (at least 32 characters) in its environment:
--
--   psql -v ON_ERROR_STOP=1 -f infra/postgres/monitoring-role.sql
--
-- Idempotent: creates `og_monitor` if missing, then (re)states every attribute and the password, so a
-- re-run converges instead of failing, and a password rotated in infra/.env lands on the next `up`.
--
-- `og_monitor` gets pg_monitor and nothing else: it can read statistics and settings, and cannot
-- read a table, write anything, create objects or replicate. The attributes are stated explicitly on
-- ALTER, not only on CREATE, so a role someone hand-edited into a superuser is demoted again.
--
-- THE PASSWORD MUST NEVER BE LOGGED. That is why it takes this shape:
--   - It comes from the environment via \getenv, never from a -v on the command line (which
--     `ps` and `docker inspect` would show) and never from this committed file.
--   - The statements carrying it are built by format(%L) and run with \gexec, because psql does not
--     interpolate its variables inside a DO block.
--   - Every setting that can write a statement's text to the server log is forced off for this
--     session only. log_min_error_statement matters by default: it is `error`, so an ALTER ROLE ...
--     PASSWORD that FAILS would land in the log verbatim. log_statement, log_min_duration_statement,
--     log_min_duration_sample and log_transaction_sample_rate only matter if an operator turned them
--     on (e.g. `=0` to log every statement's duration, or sampling whole transactions), but then
--     they log the SUCCESSFUL one, password included. All five are superuser-only settings, which
--     the opengateway role is.
--   - VERBOSITY terse, so a client-side error prints no `LINE 1: ...` excerpt of the statement.
-- The password travels to the server in clear over the compose network and is stored as a
-- scram-sha-256 verifier (password_encryption's default since Postgres 14).

\set ON_ERROR_STOP on
\set ECHO none
\set VERBOSITY terse

SET log_statement = 'none';
SET log_min_error_statement = 'panic';
SET log_min_duration_statement = -1;
SET log_min_duration_sample = -1;
SET log_transaction_sample_rate = 0;

-- Fail closed on a missing, empty or short password. pg-monitoring-init already checks this before
-- psql starts (so compose sees exit 1); this repeats it for a hand-run of the file, which must not
-- ALTER the role to an empty password either.
\getenv og_monitor_password PG_EXPORTER_PASSWORD
\if :{?og_monitor_password}
\else
  \set og_monitor_password ''
\endif
SELECT length(:'og_monitor_password') < 32 AS og_monitor_password_short \gset
\if :og_monitor_password_short
  \warn 'PG_EXPORTER_PASSWORD unset or shorter than 32 characters; og_monitor left untouched'
  -- psql's \quit always exits 0, so fail through ON_ERROR_STOP instead.
  SELECT 1 / 0 AS pg_exporter_password_short;
\endif

SELECT 'CREATE ROLE og_monitor LOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'og_monitor')
\gexec

SELECT format(
  'ALTER ROLE og_monitor WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT PASSWORD %L',
  :'og_monitor_password'
)
\gexec

GRANT pg_monitor TO og_monitor;

\unset og_monitor_password
