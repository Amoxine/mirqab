-- WP7: Kratos is now the credential store (see migrate-users-to-kratos.ts and
-- apps/web/src/app/oauth2/login/route.ts). `users.password` is no longer read for auth — Kratos-
-- native users carry only a random placeholder there — so it can stop being required. Dropping
-- NOT NULL is additive/reversible and touches no FK or index.
--
-- Idempotent: DROP COLUMN/CONSTRAINT-style guards don't apply to ALTER COLUMN ... DROP NOT NULL;
-- it's already a no-op replay against a column that's already nullable.
ALTER TABLE "users" ALTER COLUMN "password" DROP NOT NULL;
