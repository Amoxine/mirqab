'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { RegistrationFlow } from '@ory/client-fetch';
import { kratos } from '@/lib/kratos-client';
import { ACCEPT_JSON, useKratosFlow } from '@/lib/use-kratos-flow';
import { sanitizeClientReturnTo } from '@/lib/return-to';
import { KratosFlowForm } from '@/components/auth/kratos-flow-form';
import { AuthErrorCard } from '@/components/auth/auth-error-card';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/** Kratos registration UI at `/auth/register` (kratos.yml's `selfservice.flows.registration.ui_url`). */
export default function RegisterPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full max-w-md" aria-busy="true" />}>
      <RegisterPageContent />
    </Suspense>
  );
}

function RegisterPageContent() {
  const t = useTranslations('auth');
  const tNav = useTranslations('nav');
  const { flow, error, onFlowUpdate, onError } = useKratosFlow<RegistrationFlow>(
    (flowId) =>
      flowId ? kratos.getRegistrationFlow({ id: flowId }) : kratos.createBrowserRegistrationFlow({}, ACCEPT_JSON),
    t('register.flowError'),
  );

  const onSuccess = () => {
    // Registration does NOT log the user in: kratos.yml configures no `session` hook, so the
    // completed flow answers `{ identity, continue_with }` with no session (probed) and the browser
    // lands on `return_to` — normally `/`, which bounces through the OAuth2 login and puts them on
    // `/auth/login`. A real navigation, not router.push(): see the login page's comment, including
    // on re-sanitizing client-side rather than trusting Kratos's own (differently-parsed) check.
    window.location.href = sanitizeClientReturnTo(flow?.return_to);
  };

  if (error) return <AuthErrorCard message={error} />;
  if (!flow) return <Skeleton className="h-96 w-full max-w-md" aria-busy="true" />;

  return (
    <Card className="w-full max-w-md border-border/50 shadow-lg">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl font-bold">{t('register.title')}</CardTitle>
        <CardDescription>{t('register.description', { brand: tNav('brand') })}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <KratosFlowForm ui={flow.ui} onSuccess={onSuccess} onFlowUpdate={onFlowUpdate} onError={onError} />
        <p className="text-center text-sm text-muted-foreground">
          {t('register.alreadyHaveAccount')}{' '}
          <Link href="/auth/login" className="underline">
            {t('register.signIn')}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
