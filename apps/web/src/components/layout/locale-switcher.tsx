'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Languages } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
        <Button variant="ghost" size="icon" disabled={isPending} aria-label={t('label')} className="size-11 rounded-full bg-foreground/[0.06] hover:bg-foreground/[0.1]">
          <Languages className="h-4 w-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {LOCALES.map((code) => (
          <DropdownMenuItem
            key={code}
            disabled={code === locale}
            // The option names itself in its own language, so tag it for correct pronunciation.
            lang={code}
            onClick={() => {
              startTransition(() => {
                void setLocale(code).then(() => {
                  router.refresh();
                });
              });
            }}
          >
            {t(code)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
