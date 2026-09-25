'use client';

import { usePathname } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { StateCard } from '@/components/shared/state-card';
import { Button } from '@/components/ui/button';

/** Shared by every `(auth)/auth/*` page for "the flow itself could not be started/loaded" —
 * distinct from `KratosFlowForm`'s own in-form validation messages. The retry is a full navigation
 * to the bare page: without `?flow=` the page starts a fresh flow, which is what a stale or
 * failed one needs. */
export function AuthErrorCard({ message }: { message: string }) {
  const pathname = usePathname();
  const t = useTranslations('common');
  return (
    <div className="w-full max-w-md">
      <StateCard role="alert" icon={<AlertTriangle className="text-destructive" aria-hidden="true" />} message={message}>
        <Button asChild variant="outline">
          <a href={pathname}>{t('retry')}</a>
        </Button>
      </StateCard>
    </div>
  );
}
