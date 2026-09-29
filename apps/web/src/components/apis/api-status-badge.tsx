'use client';

import { useTranslations } from 'next-intl';
import { StatusBadge } from '@open-gateway/ui';
import type { ApiStatus } from '@/types';

const VARIANTS = {
  ACTIVE: 'default',
  DRAFT: 'secondary',
  DISABLED: 'destructive',
} as const;

/** Lifecycle status of an API (`DRAFT` / `ACTIVE` / `DISABLED`). */
export function ApiStatusBadge({ status }: { status: ApiStatus }) {
  const t = useTranslations('apis');
  return (
    <StatusBadge
      status={status}
      variants={VARIANTS}
      labels={{
        ACTIVE: t('status.active'),
        DRAFT: t('status.draft'),
        DISABLED: t('status.disabled'),
      }}
    />
  );
}
