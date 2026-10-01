'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { LOCALES } from '@/i18n/locales';
import type { Locale } from '@/i18n/locales';

/** Writes the `locale` cookie `i18n/request.ts` reads, then a full reload — same pattern as
 * `header.tsx`'s tenant switcher, for the same reason: several tenant-scoped/locale-scoped queries
 * would otherwise need hand-picked invalidation. */
async function setLocale(locale: Locale): Promise<void> {
  await fetch('/locale', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locale }),
  });
  window.location.reload();
}

export function LocaleSwitcher() {
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations('localeSwitcher');
  const [isPending, startTransition] = useTransition();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* The current language's code, not a bare icon: what is selected is visible without opening it. */}
        <Button
          variant="ghost"
          size="icon"
          disabled={isPending}
          aria-label={t('label')}
          className="size-11 rounded-full bg-foreground/[0.06] font-mono text-xs font-semibold uppercase hover:bg-foreground/[0.1]"
        >
          {locale}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={locale}
          onValueChange={(code) => {
            if (code === locale) return;
            startTransition(() => {
              void setLocale(code as Locale).then(() => {
                router.refresh();
              });
            });
          }}
        >
          {LOCALES.map((code) => (
            // The option names itself in its own language, so tag it for correct pronunciation.
            <DropdownMenuRadioItem key={code} value={code} lang={code}>
              {t(code)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
