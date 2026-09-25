'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { LoginFlow } from '@ory/client-fetch';
import { kratos } from '@/lib/kratos-client';
import { ACCEPT_JSON, useKratosFlow } from '@/lib/use-kratos-flow';
import { sanitizeClientReturnTo } from '@/lib/return-to';
import { KratosFlowForm } from '@/components/auth/kratos-flow-form';
import { AuthErrorCard } from '@/components/auth/auth-error-card';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Kratos login UI at `/auth/login` (infra/ory/kratos/kratos.yml's `selfservice.flows.login.ui_url`).
 * Reached two ways: with `?flow=` (Hydra's `/oauth2/login` sent the browser here mid-OAuth2 flow —
 * see that route) or cold (a bookmark / direct link), in which case a fresh flow is started here.
 */
// `useSearchParams()` (inside useKratosFlow) opts a page out of static prerendering unless it's
// wrapped in Suspense — Next.js build error otherwise ("missing-suspense-with-csr-bailout").
export default function LoginPage() {
  return (
    <Suspense fallback={<Skeleton className="h-80 w-full max-w-md" aria-busy="true" />}>
      <LoginPageContent />
    </Suspense>
  );
}

function LoginPageContent() {
  const t = useTranslations('auth');
  const { flow, error, onFlowUpdate, onError } = useKratosFlow<LoginFlow>(
    (flowId) => (flowId ? kratos.getLoginFlow({ id: flowId }) : kratos.createBrowserLoginFlow({}, ACCEPT_JSON)),
    t('login.flowError'),
  );

  const onSuccess = () => {
    // Mid-OAuth2, `return_to` IS `/oauth2/login?login_challenge=…` — that route puts the challenge
    // there rather than handing it to Kratos (see its comment), which is why `oauth2_login_challenge`
    // is always null here and the branch that read it was dead. A cold flow lands on its own
    // return_to, or home.
    //
    // A real navigation, not router.push(): the destination is a Route Handler, which the App
    // Router cannot render. Kratos checks return_to against allowed_return_urls with Go's net/url,
    // but the browser resolves it with the WHATWG parser and the two can disagree — re-sanitize
    // with the parser that actually resolves it, see sanitizeClientReturnTo's own comment.
    window.location.href = sanitizeClientReturnTo(flow?.return_to);
  };

  if (error) return <AuthErrorCard message={error} />;
  if (!flow) return <Skeleton className="h-80 w-full max-w-md" aria-busy="true" />;

  return (
    <Card className="w-full max-w-md border-border/50 shadow-lg">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl font-bold">{t('login.title')}</CardTitle>
        <CardDescription>{t('login.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <KratosFlowForm ui={flow.ui} onSuccess={onSuccess} onFlowUpdate={onFlowUpdate} onError={onError} />
        <div className="flex flex-wrap justify-between gap-x-4 gap-y-2 text-sm text-muted-foreground">
          <Link href="/auth/recovery" className="underline">
            {t('login.forgotPassword')}
          </Link>
          <Link href="/auth/register" className="underline">
            {t('login.createAccount')}
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
