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
 * Reuses the dashboard's own Kratos flow components verbatim (`KratosFlowForm`, `useKratosFlow`,
 * the `kratos` browser client) — the same Kratos instance serves both identity domains, and a
 * login flow is a login flow regardless of which app started it. Only what's portal-specific is
 * here: the copy, and `onSuccess` landing straight on the catalog instead of Hydra's `/oauth2/login`
 * hand-off (the portal has no Hydra step, DeveloperAuthGuard's own doc comment explains why).
 */
export default function PortalLoginPage() {
  return (
    <Suspense fallback={<Skeleton className="h-80 w-full" aria-busy="true" />}>
      <PortalLoginPageContent />
    </Suspense>
  );
}

function PortalLoginPageContent() {
  const t = useTranslations('portal');
  const tAuth = useTranslations('auth');
  const { flow, error, onFlowUpdate, onError } = useKratosFlow<LoginFlow>(
    (flowId) =>
      flowId
        ? kratos.getLoginFlow({ id: flowId })
        : kratos.createBrowserLoginFlow({ returnTo: '/portal' }, ACCEPT_JSON),
    tAuth('login.flowError'),
  );

  const onSuccess = () => {
    window.location.href = sanitizeClientReturnTo(flow?.return_to ?? '/portal');
  };

  if (error) return <AuthErrorCard message={error} />;
  if (!flow) return <Skeleton className="h-80 w-full" aria-busy="true" />;

  return (
    <Card className="border-border/50 shadow-lg">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl font-bold">{t('auth.login.title')}</CardTitle>
        <CardDescription>{t('auth.login.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <KratosFlowForm ui={flow.ui} onSuccess={onSuccess} onFlowUpdate={onFlowUpdate} onError={onError} />
        <div className="flex flex-wrap justify-between gap-x-4 gap-y-2 text-sm text-muted-foreground">
          <Link href="/portal/auth/recovery" className="underline">
            {t('auth.login.forgotPassword')}
          </Link>
          <Link href="/portal/auth/register" className="underline">
            {t('auth.login.createAccount')}
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
