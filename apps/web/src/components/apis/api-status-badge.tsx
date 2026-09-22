'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import type { ApiStatus } from '@/types';

const VARIANT: Record<ApiStatus, 'default' | 'secondary' | 'destructive'> = {
  ACTIVE: 'default',
  DRAFT: 'secondary',
  DISABLED: 'destructive',
};

/** Lifecycle status of an API (`DRAFT` / `ACTIVE` / `DISABLED`). */
export function ApiStatusBadge({ status }: { status: ApiStatus }) {
  const t = useTranslations('apis');
  const label: Record<ApiStatus, string> = {
    ACTIVE: t('status.active'),
    DRAFT: t('status.draft'),
    DISABLED: t('status.disabled'),
  };
  return <Badge variant={VARIANT[status]}>{label[status]}</Badge>;
}
