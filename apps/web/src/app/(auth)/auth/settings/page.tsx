'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { SettingsFlow } from '@ory/client-fetch';
import { kratos } from '@/lib/kratos-client';
import { parseFlowUi } from '@/lib/kratos-flow';
import { ACCEPT_JSON, useKratosFlow } from '@/lib/use-kratos-flow';
import { KratosFlowForm } from '@/components/auth/kratos-flow-form';
import { AuthErrorCard } from '@/components/auth/auth-error-card';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/sonner';

/**
 * Kratos settings UI at `/auth/settings` — profile + password, gated by Kratos itself on a
 * `privileged_session_max_age` of 15m (kratos.yml); this page doesn't re-check that, Kratos's own
 * flow responses do (a stale privileged session surfaces as a validation message on submit, which
 * `KratosFlowForm` already renders).
 *
 * Unlike login/register, a successful update is itself a fresh flow (the response IS a
 * `SettingsFlow`, `state: 'success'`) — the user stays on the page, not redirected elsewhere.
 */
export default function SettingsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full max-w-md" aria-busy="true" />}>
      <SettingsPageContent />
    </Suspense>
  );
}

function SettingsPageContent() {
  const t = useTranslations('auth');
  const { flow, error, setError, onFlowUpdate, onError } = useKratosFlow<SettingsFlow>(
    (flowId) => (flowId ? kratos.getSettingsFlow({ id: flowId }) : kratos.createBrowserSettingsFlow({}, ACCEPT_JSON)),
    t('settings.flowError'),
  );

  if (error) return <AuthErrorCard message={error} />;
  if (!flow) return <Skeleton className="h-96 w-full max-w-md" aria-busy="true" />;

  return (
    <Card className="w-full max-w-md border-border/50">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl font-bold">{t('settings.title')}</CardTitle>
        <CardDescription>{t('settings.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <KratosFlowForm
          ui={flow.ui}
          onSuccess={(body) => {
            // The saved flow comes back with a rotated CSRF token and fresh values, so it has to
            // replace what's on screen — but only after checking it really is one. A body that
            // isn't (a proxy's 200, a truncated response) used to be cast in blind and left the
            // page on a loading skeleton forever, right after saying "Saved".
            const ui = parseFlowUi(body);
            if (!ui) {
              setError(t('settings.refreshError'));
              return;
            }
            onFlowUpdate(ui);
            toast.success(t('settings.saved'));
          }}
          onFlowUpdate={onFlowUpdate}
          onError={onError}
        />
        <p className="text-center text-sm text-muted-foreground">
          <Link href="/" className="underline">
            {t('settings.backToDashboard')}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
