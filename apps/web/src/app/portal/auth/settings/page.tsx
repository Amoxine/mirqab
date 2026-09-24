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

/** Where recovery hands off to set a new password — same flow as the dashboard's `/auth/settings`,
 * reused verbatim; see that page's own comment for why a successful update re-renders in place. */
export default function PortalSettingsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" aria-busy="true" />}>
      <PortalSettingsPageContent />
    </Suspense>
  );
}

function PortalSettingsPageContent() {
  const t = useTranslations('portal');
  const tAuth = useTranslations('auth');
  const { flow, error, setError, onFlowUpdate, onError } = useKratosFlow<SettingsFlow>(
    (flowId) => (flowId ? kratos.getSettingsFlow({ id: flowId }) : kratos.createBrowserSettingsFlow({}, ACCEPT_JSON)),
    tAuth('settings.flowError'),
  );

  if (error) return <AuthErrorCard message={error} />;
  if (!flow) return <Skeleton className="h-96 w-full" aria-busy="true" />;

  return (
    <Card className="border-border/50 shadow-lg">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl font-bold">{t('auth.settings.title')}</CardTitle>
        <CardDescription>{t('auth.settings.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <KratosFlowForm
          ui={flow.ui}
          onSuccess={(body) => {
            const ui = parseFlowUi(body);
            if (!ui) {
              setError(tAuth('settings.refreshError'));
              return;
            }
            onFlowUpdate(ui);
            toast.success(tAuth('settings.saved'));
          }}
          onFlowUpdate={onFlowUpdate}
          onError={onError}
        />
        <p className="text-center text-sm text-muted-foreground">
          <Link href="/portal" className="underline">
            {t('auth.settings.backToPortal')}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
