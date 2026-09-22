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

/**
 * Kratos recovery UI at `/auth/recovery` — a 2-step code flow (request code by email, then enter
 * it), `use: code` per kratos.yml. NOTE: Kratos's SMTP is an unconfigured placeholder in this
 * stack (see kratos.yml's courier comment), so the code never actually reaches a mailbox yet — the
 * flow itself is complete and correct, it just has nowhere to deliver mail until that's wired up.
 */
export default function RecoveryPage() {
  return (
    <Suspense fallback={<Skeleton className="h-72 w-full max-w-md" aria-busy="true" />}>
      <RecoveryPageContent />
    </Suspense>
  );
}

function RecoveryPageContent() {
  const router = useRouter();
  const t = useTranslations('auth');
  const { flow, error, onFlowUpdate, onError } = useKratosFlow<RecoveryFlow>(
    (flowId) => (flowId ? kratos.getRecoveryFlow({ id: flowId }) : kratos.createBrowserRecoveryFlow({}, ACCEPT_JSON)),
    t('recovery.flowError'),
  );

  // An accepted code establishes a privileged session and hands off to settings to set a new
  // password — recovery on its own never changes the password. With `use: code` Kratos performs
  // that hand-off itself (HTTP 422 + `redirect_browser_to`, which KratosFlowForm follows); this
  // covers the link-method shape, where the flow simply reports `passed_challenge` instead.
  const onSuccess = () => {
    router.push('/auth/settings');
  };

  if (error) return <AuthErrorCard message={error} />;
  if (!flow) return <Skeleton className="h-72 w-full max-w-md" aria-busy="true" />;

  return (
    <Card className="w-full max-w-md border-border/50 shadow-lg">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl font-bold">{t('recovery.title')}</CardTitle>
        <CardDescription>{t('recovery.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <KratosFlowForm ui={flow.ui} onSuccess={onSuccess} onFlowUpdate={onFlowUpdate} onError={onError} />
        <p className="text-center text-sm text-muted-foreground">
          <Link href="/auth/login" className="underline">
            {t('recovery.backToSignIn')}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
