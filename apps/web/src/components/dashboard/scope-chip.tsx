'use client';

import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

/** "Scoped to <api>" with a button back to the gateway-wide view; shown only when the scope was picked, not automatic. */
export function ScopeChip({ name, onClear }: { name: string; onClear: () => void }) {
  const t = useTranslations('dashboard.scope');
  return (
    <Badge variant="outline" className="h-9 gap-1 ps-3 pe-1 text-sm font-normal">
      <span>{t('chip')}</span>
      <b dir="auto" className="max-w-40 truncate font-medium">
        {name}
      </b>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 rounded-full"
        aria-label={t('clear')}
        title={t('clear')}
        onClick={onClear}
      >
        <X aria-hidden="true" />
      </Button>
    </Badge>
  );
}
