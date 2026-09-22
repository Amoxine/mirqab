import { Configuration, FrontendApi } from '@ory/client-fetch';

// An unset OR empty NEXT_PUBLIC_KRATOS_URL must fall back, so this is not a `??`.
const configuredKratosUrl = process.env.NEXT_PUBLIC_KRATOS_URL ?? '';
export const KRATOS_PUBLIC_URL = configuredKratosUrl === '' ? 'http://localhost:33012' : configuredKratosUrl;

/**
 * Kratos is headless: every self-service screen (login/register/settings/recovery/verification) is
 * hand-built from this client's flow responses (`ui.nodes`), per `apps/web/src/components/auth/kratos-flow-form.tsx`.
 * `credentials: 'include'` is required — Kratos's CSRF + session cookies travel on every call.
 */
export const kratos = new FrontendApi(
  new Configuration({ basePath: KRATOS_PUBLIC_URL, credentials: 'include' }),
);
