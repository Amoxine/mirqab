'use client';

import { useTranslations } from 'next-intl';
import { StatusBadge } from '@open-gateway/ui';
import type { ApiKeyStatus } from '@/types';

const VARIANTS = {
  ACTIVE: 'default',
  REVOKED: 'destructive',
  EXPIRED: 'secondary',
} as const;

/** Lifecycle status of an API key — the same variant and translated label on the keys list, the detail page and analytics. */
export function KeyStatusBadge({ status }: { status: ApiKeyStatus }) {
  const t = useTranslations('keys');
  return (
    <StatusBadge
      status={status}
      variants={VARIANTS}
      labels={{
        ACTIVE: t('status.ACTIVE'),
        REVOKED: t('status.REVOKED'),
        EXPIRED: t('status.EXPIRED'),
      }}
    />
  );
}
