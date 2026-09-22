-- Creates one database per Ory service, separate from the `opengateway` app database.
--
-- Idempotent on purpose: this runs as a compose job on every `up`, not as a
-- docker-entrypoint-initdb.d script (those only fire when the postgres volume is first
-- initialised, which already happened on existing installs). Postgres has no
-- CREATE DATABASE IF NOT EXISTS, so each statement is generated only when absent and
-- executed by psql's \gexec.

SELECT 'CREATE DATABASE hydra OWNER opengateway'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'hydra')\gexec

SELECT 'CREATE DATABASE kratos OWNER opengateway'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'kratos')\gexec

SELECT 'CREATE DATABASE keto OWNER opengateway'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'keto')\gexec
