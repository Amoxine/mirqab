'use client';

import { useEffect, useMemo, useState } from 'react';
import { BookOpen } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { OverlaysContext, type Overlays } from '@/components/layout/overlays-context';
import { useNavItems } from '@/components/layout/sidebar';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useDocsSearch } from '@/hooks/use-docs-search';

/** Page search over the permission-gated navigation (⌘/Ctrl + K). */
function SearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('dashboard.palette');
  const router = useRouter();
  const items = useNavItems();
  const [query, setQuery] = useState('');
  const docs = useDocsSearch(open ? query : '');

  const go = (href: string) => {
    onOpenChange(false);
    setQuery('');
    router.push(href);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <DialogTitle className="sr-only">{t('title')}</DialogTitle>
      <DialogDescription className="sr-only">{t('description')}</DialogDescription>
      <CommandInput placeholder={t('placeholder')} aria-label={t('placeholder')} value={query} onValueChange={setQuery} />
      <CommandList>
        <CommandEmpty>{t('empty')}</CommandEmpty>
        <CommandGroup heading={t('pages')}>
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <CommandItem
                key={item.href}
                value={item.label}
                onSelect={() => {
                  onOpenChange(false);
                  router.push(item.href);
                }}
              >
                <Icon className="me-2 h-4 w-4" aria-hidden="true" />
                {item.label}
              </CommandItem>
            );
          })}
        </CommandGroup>
        <CommandGroup heading={t('docs')}>
          <CommandItem
            value={t('docsHome')}
            onSelect={() => {
              go('/docs');
            }}
          >
            <BookOpen className="me-2 h-4 w-4" aria-hidden="true" />
            {t('docsHome')}
          </CommandItem>
          {/* Hits come from the docs' own search, which already matched them: `forceMount` stops cmdk filtering them out again. */}
          {(docs.data ?? []).map((hit) => (
            <CommandItem
              key={hit.url}
              value={`docs ${hit.url}`}
              forceMount
              onSelect={() => {
                go(hit.url);
              }}
            >
              <BookOpen className="me-2 h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0">
                <span dir="auto" className="block truncate">
                  {hit.title}
                </span>
                {hit.trail && (
                  <span dir="auto" className="text-muted-foreground block truncate text-xs">
                    {hit.trail}
                  </span>
                )}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

function HelpDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('dashboard.help');
  const shortcuts = [
    { keys: t('searchKeys'), label: t('search') },
    { keys: t('closeKeys'), label: t('close') },
    { keys: t('chartKeys'), label: t('chart') },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('intro')}</DialogDescription>
        </DialogHeader>
        <h3 className="text-muted-foreground font-mono text-[0.68rem] font-medium uppercase tracking-widest">
          {t('shortcuts')}
        </h3>
        <ul className="space-y-2 text-sm">
          {shortcuts.map((s) => (
            <li key={s.label} className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">{s.label}</span>
              <kbd dir="ltr" className="rounded-md border px-2 py-0.5 font-mono text-xs">
                {s.keys}
              </kbd>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button
            type="button"
            className="rounded-full"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t('done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function OverlaysProvider({ children }: { children: React.ReactNode }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const value = useMemo<Overlays>(
    () => ({
      openSearch: () => {
        setSearchOpen(true);
      },
      openHelp: () => {
        setHelpOpen(true);
      },
    }),
    [],
  );

  return (
    <OverlaysContext.Provider value={value}>
      {children}
      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
      <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </OverlaysContext.Provider>
  );
}
