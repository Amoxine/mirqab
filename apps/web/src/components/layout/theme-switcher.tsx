'use client';

import { useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { BRANDS, DEFAULT_BRAND, applyBrand, isBrand } from '@/lib/brand';

const THEMES = [
  { value: 'light', icon: Sun },
  { value: 'dark', icon: Moon },
  { value: 'system', icon: Monitor },
] as const;

/** The brand on <html>; the menu content only renders in the browser, so `document` is there. */
const currentBrand = () => {
  const value = typeof document === 'undefined' ? undefined : document.documentElement.dataset.brand;
  return isBrand(value) ? value : DEFAULT_BRAND;
};

/**
 * Appearance: light / dark / follow-the-OS, and the brand colour. next-themes sets `.dark` before
 * paint; the brand is a cookie the server reads, so neither flashes on load and neither reloads.
 */
export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const t = useTranslations('common.themeSwitcher');
  const [brand, setBrand] = useState(currentBrand);

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) setBrand(currentBrand());
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          aria-label={t('label')}
          className="h-11 gap-0.5 rounded-full bg-foreground/[0.06] p-1 hover:bg-foreground/[0.1]"
        >
          {/* Both icons show; the active one sits on a raised chip. Picked by the `.dark` class
              rather than `theme`, which is unknown until hydration. */}
          <span className="grid size-9 place-items-center rounded-full bg-card text-foreground shadow-sm transition-colors dark:bg-transparent dark:text-muted-foreground dark:shadow-none">
            <Sun className="h-4 w-4" aria-hidden="true" />
          </span>
          <span className="grid size-9 place-items-center rounded-full text-muted-foreground transition-colors dark:bg-card dark:text-foreground dark:shadow-sm">
            <Moon className="h-4 w-4" aria-hidden="true" />
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="text-muted-foreground text-xs font-medium">{t('mode')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={setTheme} aria-label={t('mode')}>
          {THEMES.map(({ value, icon: Icon }) => (
            <DropdownMenuRadioItem key={value} value={value} className="gap-2">
              <Icon className="h-4 w-4" aria-hidden="true" />
              {t(value)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-muted-foreground text-xs font-medium">{t('color')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          aria-label={t('color')}
          value={brand}
          onValueChange={(value) => {
            if (!isBrand(value)) return;
            applyBrand(value);
            setBrand(value);
          }}
        >
          {BRANDS.map((value) => (
            <DropdownMenuRadioItem key={value} value={value} className="gap-2">
              {/* The swatch carries its own data-brand, so it is drawn from the same CSS values. */}
              <span
                data-brand={value}
                aria-hidden="true"
                className="size-4 shrink-0 rounded-full bg-[var(--brand)] ring-1 ring-black/10 dark:bg-[var(--brand-on-dark)] dark:ring-white/15"
              />
              {t(`brands.${value}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
