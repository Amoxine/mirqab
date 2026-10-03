'use client';

import { useDocsSearch } from 'fumadocs-core/search/client';
import { useTranslations } from 'next-intl';
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogFooter,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from 'fumadocs-ui/components/dialog/search';
import { useI18n } from 'fumadocs-ui/contexts/i18n';

/**
 * Fumadocs' default search dialog, rebuilt around one difference: its close button says "ESC" in
 * English in every language. Same endpoint, same list, same keyboard behaviour.
 */
export function DocsSearchDialog({ api, ...props }: SharedProps & { api?: string }) {
  const t = useTranslations('docs.shell');
  const { locale } = useI18n();
  const { search, setSearch, query } = useDocsSearch({ type: 'fetch', api, locale });

  return (
    <SearchDialog search={search} onSearchChange={setSearch} isLoading={query.isLoading} {...props}>
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose>{t('closeSearch')}</SearchDialogClose>
        </SearchDialogHeader>
        <SearchDialogList items={query.data !== 'empty' ? query.data : null} />
      </SearchDialogContent>
      <SearchDialogFooter />
    </SearchDialog>
  );
}
