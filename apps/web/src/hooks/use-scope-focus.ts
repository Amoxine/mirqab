'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { DashboardScope } from '@/hooks/use-dashboard-scope';

/**
 * "Show only {API}" narrows the whole dashboard in place: without help, focus stays on a button that
 * has just become part of a different view, and a screen reader is told nothing. This moves focus to
 * the scope chip's clear button, the control for what just changed, and announces what the dashboard
 * now shows. It acts only for a pick made through `select` (a scope that was already in the URL, or the
 * automatic one of a gateway with a single API, has no chip and nothing was just done).
 */
export function useScopeFocus(scope: DashboardScope) {
  const t = useTranslations('dashboard.scope');
  const chipRef = useRef<HTMLButtonElement>(null);
  const picked = useRef(false);
  const [announcement, setAnnouncement] = useState('');
  const apiName = scope.api?.name;
  const hasChip = scope.api !== null && !scope.auto;

  useEffect(() => {
    if (!picked.current || !hasChip || apiName === undefined) return;
    picked.current = false;
    chipRef.current?.focus();
    setAnnouncement(t('announce', { name: apiName }));
  }, [hasChip, apiName, t]);

  return {
    chipRef,
    announcement,
    select: (apiId: string) => {
      picked.current = true;
      scope.select(apiId);
    },
    clear: () => {
      picked.current = false;
      setAnnouncement('');
      scope.clear();
    },
  };
}
