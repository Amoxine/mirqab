'use client';

import { useTranslations } from 'next-intl';
import {
  DataTable as BaseDataTable,
  DataTablePagination as BaseDataTablePagination,
  ViewModeToggle as BaseViewModeToggle,
  useViewMode,
  type DataTableProps,
  type ViewMode,
} from '@open-gateway/ui';

/*
 * The list pages' table, card view and pagination live in packages/ui (prop-driven, no i18n).
 * These wrappers keep every existing call site unchanged by supplying the translated labels.
 * The FROZEN view-mode contract is documented on the shared component.
 */
export { useViewMode, type ViewMode };

/** Table/card switch. Pure presentation — the caller owns the state, via `useViewMode` or its own. */
export function ViewModeToggle({
  mode,
  onChange,
}: {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
}) {
  const t = useTranslations('dashboard.dataTable');
  return (
    <BaseViewModeToggle
      mode={mode}
      onChange={onChange}
      labels={{ group: t('viewMode'), table: t('tableView'), card: t('cardView') }}
    />
  );
}

/** Shared table chrome for the dashboard's list pages: header + loading/error/empty/data body. */
export function DataTable<TData>(props: Omit<DataTableProps<TData>, 'labels'>) {
  const t = useTranslations('dashboard.dataTable');
  const tCommon = useTranslations('common');
  return (
    <BaseDataTable
      {...props}
      labels={{ retry: tCommon('retry'), unexpectedError: t('unexpectedError') }}
    />
  );
}

/** Shared "Page X of Y (N total)" + Previous/Next footer for the dashboard's list pages. */
export function DataTablePagination({
  page,
  totalPages,
  totalCount,
  onPrevious,
  onNext,
}: {
  page: number;
  totalPages: number;
  totalCount?: number;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const t = useTranslations('dashboard.dataTable');
  return (
    <BaseDataTablePagination
      page={page}
      totalPages={totalPages}
      summary={
        <>
          {t('pageOf', { page, totalPages })}
          {totalCount !== undefined && <> {t('totalCount', { count: totalCount })}</>}
        </>
      }
      previousLabel={t('previous')}
      nextLabel={t('next')}
      onPrevious={onPrevious}
      onNext={onNext}
    />
  );
}
