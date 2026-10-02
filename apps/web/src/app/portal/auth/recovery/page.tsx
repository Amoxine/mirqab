'use client';

import { Suspense } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { RecoveryFlow } from '@ory/client-fetch';
import { kratos } from '@/lib/kratos-client';
import { ACCEPT_JSON, useKratosFlow } from '@/lib/use-kratos-flow';
import { KratosFlowForm } from '@/components/auth/kratos-flow-form';
import { AuthErrorCard } from '@/components/auth/auth-error-card';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/** Same 2-step `code` recovery flow as the dashboard's `/auth/recovery`, reused verbatim — see that
 * page's own comment for the SMTP caveat, which applies here identically (one Kratos instance). */
export default function PortalRecoveryPage() {
  return (
    <Suspense fallback={<Skeleton className="h-72 w-full" aria-busy="true" />}>
      <PortalRecoveryPageContent />
    </Suspense>
  );
}

function PortalRecoveryPageContent() {
  const router = useRouter();
  const t = useTranslations('portal');
  const tAuth = useTranslations('auth');
  const { flow, error, onFlowUpdate, onError } = useKratosFlow<RecoveryFlow>(
    (flowId) => (flowId ? kratos.getRecoveryFlow({ id: flowId }) : kratos.createBrowserRecoveryFlow({}, ACCEPT_JSON)),
    tAuth('recovery.flowError'),
  );

  const onSuccess = () => {
    router.push('/portal/auth/settings');
  };

  if (error) return <AuthErrorCard message={error} />;
  if (!flow) return <Skeleton className="h-72 w-full" aria-busy="true" />;

  return (
    <Card className="border-border/50">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl font-bold">{t('auth.recovery.title')}</CardTitle>
        <CardDescription>{t('auth.recovery.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <KratosFlowForm ui={flow.ui} onSuccess={onSuccess} onFlowUpdate={onFlowUpdate} onError={onError} />
        <p className="text-center text-sm text-muted-foreground">
          <Link href="/portal/auth/login" className="underline">
            {t('auth.recovery.backToSignIn')}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
