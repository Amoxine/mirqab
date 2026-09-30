'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { ChipInput, type ChipInputChip } from '@open-gateway/ui';
import { Button } from '@/components/ui/button';
import type { SearchToken } from '@/hooks/use-search-query';

/** Example searches, shown as the tokens they are: the syntax is the label. */
const PRESETS = ['status:>=500', 'status:4xx', 'latency:>800 method:POST', 'body:"insufficient funds"'] as const;

/**
 * The search box: each filter becomes a chip, a chip that cannot be understood is shown as an error with
 * its reason underneath (translated from the parser's code), and a few presets fill the bar in one click.
 */
export function SearchBar({
  tokens,
  tooMany,
  onAdd,
  onRemove,
  onPreset,
}: {
  tokens: SearchToken[];
  tooMany: 'clauses' | 'bodyClauses' | null;
  onAdd: (text: string) => void;
  onRemove: (index: number) => void;
  onPreset: (text: string) => void;
}) {
  const t = useTranslations('analytics.search');
  const hintId = useId();

  const chips: ChipInputChip[] = tokens.map((token, index) => ({
    id: `${String(index)}:${token.text}`,
    text: token.text,
    tone: !token.parsed.ok ? 'error' : token.text.startsWith('-') ? 'negated' : 'default',
  }));
  const problems = tokens.flatMap((token) =>
    token.parsed.ok ? [] : [{ text: token.text, message: t(`errors.${token.parsed.error.code}`, token.parsed.error.params) }],
  );

  return (
    <div className="space-y-2">
      <ChipInput
        chips={chips}
        describedBy={hintId}
        onSubmit={onAdd}
        onRemove={(id) => {
          onRemove(Number(id.slice(0, id.indexOf(':'))));
        }}
        labels={{
          input: t('inputLabel'),
          placeholder: t('placeholder'),
          remove: (text) => t('removeChip', { text }),
          edit: (text) => t('editChip', { text }),
        }}
      />
      <div id={hintId} className="space-y-1 text-xs" role="status" aria-live="polite">
        {problems.map((problem) => (
          <p key={problem.text} className="text-destructive">
            <code dir="ltr" className="font-mono">
              {problem.text}
            </code>
            {': '}
            {problem.message}
          </p>
        ))}
        {tooMany && <p className="text-destructive">{t(`errors.${tooMany === 'clauses' ? 'tooManyClauses' : 'tooManyBodyClauses'}`)}</p>}
        {problems.length === 0 && !tooMany && <p className="text-muted-foreground">{t('syntaxHint')}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5" aria-label={t('presetsLabel')} role="group">
        {PRESETS.map((preset) => (
          <Button
            key={preset}
            type="button"
            variant="outline"
            size="sm"
            className="h-7 font-mono text-xs"
            dir="ltr"
            onClick={() => {
              onPreset(preset);
            }}
          >
            {preset}
          </Button>
        ))}
      </div>
    </div>
  );
}
