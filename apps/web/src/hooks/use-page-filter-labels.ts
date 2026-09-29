import { useTranslations } from 'next-intl';
import type { PageFilterLabels } from '@open-gateway/ui';

/**
 * The three strings every `PageFilter` needs, from the shared `common` messages, so a page that
 * filters only supplies its own field labels. Pass `resetLabel` where "Clear all" reads better.
 */
export function usePageFilterLabels(resetLabel?: string): PageFilterLabels {
  const t = useTranslations('common');
  return {
    title: t('filters'),
    reset: resetLabel ?? t('clearFilters'),
    active: (count) => t('activeFilters', { count }),
  };
}
