'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const THEMES = [
  { value: 'light', icon: Sun },
  { value: 'dark', icon: Moon },
  { value: 'system', icon: Monitor },
] as const;

/** Light / dark / follow-the-OS. next-themes persists the pick in localStorage and sets the `.dark`
 * class on <html> before paint, so there's no cookie or reload like the locale switcher needs. */
export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const t = useTranslations('common.themeSwitcher');

  return (
    <DropdownMenu>
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
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
          {THEMES.map(({ value, icon: Icon }) => (
            <DropdownMenuRadioItem key={value} value={value} className="gap-2">
              <Icon className="h-4 w-4" aria-hidden="true" />
              {t(value)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
