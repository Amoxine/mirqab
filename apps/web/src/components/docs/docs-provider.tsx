'use client';

import { useEffect, useState, type ComponentProps } from 'react';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { isKKey } from '@/lib/hotkey';
import { DocsSearchDialog } from './docs-search-dialog';

/** "⌘" on a Mac, "Ctrl" on Windows: the key the shortcut hint shows. */
function MetaOrControl() {
  const [key, setKey] = useState('⌘');
  useEffect(() => {
    if (window.navigator.userAgent.includes('Windows')) setKey('Ctrl');
  }, []);
  return key;
}

/**
 * Ctrl/⌘ + K. Fumadocs' default compares `event.key` with "k", which an Arabic layout never produces,
 * so the shortcut only worked for people typing Latin letters.
 */
const HOT_KEY = [
  { key: (event: KeyboardEvent) => event.metaKey || event.ctrlKey, display: <MetaOrControl /> },
  { key: isKKey, display: 'K' },
];

type DocsProviderProps = Pick<ComponentProps<typeof RootProvider>, 'dir' | 'i18n' | 'children'>;

/**
 * Fumadocs' root provider with this app's search dialog and shortcut. A client component because the
 * dialog and the shortcut are functions, which a server layout cannot hand to a client provider.
 */
export function DocsProvider({ dir, i18n, children }: DocsProviderProps) {
  return (
    <RootProvider
      dir={dir}
      // The app's root <Providers> already mounts next-themes with attribute="class"; reuse it.
      theme={{ enabled: false }}
      search={{ SearchDialog: DocsSearchDialog, options: { api: '/docs/search-index' }, hotKey: HOT_KEY }}
      i18n={i18n}
    >
      {children}
    </RootProvider>
  );
}
