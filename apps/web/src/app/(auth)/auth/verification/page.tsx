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

/**
 * Kratos verification UI at `/auth/verification` — a 2-step code flow, same caveat as recovery:
 * SMTP is an unconfigured placeholder in this stack, so the code doesn't reach a mailbox yet.
 */
export default function VerificationPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full max-w-md" aria-busy="true" />}>
      <VerificationPageContent />
    </Suspense>
  );
}

function VerificationPageContent() {
  const t = useTranslations('auth');
  const { flow, error, onFlowUpdate, onError } = useKratosFlow<VerificationFlow>(
    (flowId) =>
      flowId ? kratos.getVerificationFlow({ id: flowId }) : kratos.createBrowserVerificationFlow({}, ACCEPT_JSON),
    t('verification.flowError'),
  );
  // Reached only once Kratos reports `state: 'passed_challenge'` — submitting the address is a 200
  // too, so this must never be driven by "the request succeeded".
  const [verified, setVerified] = useState(false);

  if (error) return <AuthErrorCard message={error} />;

  if (verified) {
    return (
      <Card className="w-full max-w-md border-border/50 shadow-lg">
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <CheckCircle2 className="h-10 w-10 text-primary" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">{t('verification.verified')}</p>
          <Link href="/" className="text-sm underline">
            {t('verification.continueToDashboard')}
          </Link>
        </CardContent>
      </Card>
    );
  }

  if (!flow) return <Skeleton className="h-64 w-full max-w-md" aria-busy="true" />;

  return (
    <Card className="w-full max-w-md border-border/50 shadow-lg">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl font-bold">{t('verification.title')}</CardTitle>
        <CardDescription>{t('verification.description')}</CardDescription>
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
