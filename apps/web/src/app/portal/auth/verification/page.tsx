'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { VerificationFlow } from '@ory/client-fetch';
import { kratos } from '@/lib/kratos-client';
import { ACCEPT_JSON, useKratosFlow } from '@/lib/use-kratos-flow';
import { KratosFlowForm } from '@/components/auth/kratos-flow-form';
import { AuthErrorCard } from '@/components/auth/auth-error-card';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/** Where the code from registration's verification email is entered — same 2-step `code` flow as
 * the dashboard's `/auth/verification`, reused verbatim. */
export default function PortalVerificationPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" aria-busy="true" />}>
      <PortalVerificationPageContent />
    </Suspense>
  );
}

function PortalVerificationPageContent() {
  const t = useTranslations('portal');
  const tAuth = useTranslations('auth');
  const { flow, error, onFlowUpdate, onError } = useKratosFlow<VerificationFlow>(
    (flowId) =>
      flowId ? kratos.getVerificationFlow({ id: flowId }) : kratos.createBrowserVerificationFlow({}, ACCEPT_JSON),
    tAuth('verification.flowError'),
  );
  const [verified, setVerified] = useState(false);

  if (error) return <AuthErrorCard message={error} />;

  if (verified) {
    return (
      <Card className="border-border/50 shadow-lg">
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <CheckCircle2 className="h-10 w-10 text-primary" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">{t('auth.verification.verified')}</p>
          <Link href="/portal/auth/login" className="text-sm underline">
            {t('auth.verification.continueToSignIn')}
          </Link>
        </CardContent>
      </Card>
    );
  }

  if (!flow) return <Skeleton className="h-64 w-full" aria-busy="true" />;

  return (
    <Card className="border-border/50 shadow-lg">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl font-bold">{t('auth.verification.title')}</CardTitle>
        <CardDescription>{t('auth.verification.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <KratosFlowForm
          ui={flow.ui}
          onSuccess={() => {
            setVerified(true);
          }}
          onFlowUpdate={onFlowUpdate}
          onError={onError}
        />
      </CardContent>
    </Card>
  );
}
