'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChipInput, type ChipInputChip } from '@open-gateway/ui';
import { Button } from '@/components/ui/button';
import type { SearchToken } from '@/hooks/use-search-query';
import { useSearchSuggestions } from '@/hooks/use-search-suggestions';
import { SEARCH_LIMITS } from '@/lib/traffic-search';
import { draftHint, suggest } from '@/lib/traffic-search-suggest';
import type { AnalyticsRange } from '@/types';

/** Example searches, shown as the tokens they are: the syntax is the label. */
const PRESETS = ['status:>=500', 'status:4xx', 'latency:>800 method:POST', 'body:"insufficient funds"'] as const;

/**
 * The search box: each filter becomes a chip, a chip that cannot be understood is shown as an error with
 * its reason underneath (translated from the parser's code), and a few presets fill the bar in one click.
 * The field suggests filters, and values for the one being typed, as a dropdown (`lib/traffic-search-suggest.ts`).
 */
export function SearchBar({
  tokens,
  tooMany,
  range,
  onAdd,
  onRemove,
  onPreset,
}: {
  tokens: SearchToken[];
  tooMany: 'clauses' | 'bodyClauses' | null;
  /** The window the lists of APIs, keys and paths are read for. */
  range: AnalyticsRange;
  onAdd: (text: string) => void;
  onRemove: (index: number) => void;
  onPreset: (text: string) => void;
}) {
  const t = useTranslations('analytics.search');
  const hintId = useId();
  const [draft, setDraft] = useState('');
  const lists = useSearchSuggestions(draft, tokens, range);
  const suggestions = suggest(draft, {
    ...lists,
    fieldDescription: (field) => t(`suggest.fields.${field}`),
    statusMeaning: (value) => t(`suggest.status.${value.replace('>=', 'gte')}`),
    latencyOver: (ms) => t('suggest.latencyOver', { ms }),
  });
  const hint = draftHint(draft);

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
        onDraftChange={setDraft}
        suggestions={suggestions}
        labels={{
          input: t('inputLabel'),
          placeholder: t('placeholder'),
          remove: (text) => t('removeChip', { text }),
          edit: (text) => t('editChip', { text }),
          suggestions: t('suggest.listLabel'),
          suggestionCount: (count) => t('suggest.count', { count }),
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
        {problems.length === 0 &&
          !tooMany &&
          (hint?.kind === 'commonWord' ? (
            <p className="text-destructive">{t('errors.commonWord', { term: hint.term })}</p>
          ) : (
            <p className="text-muted-foreground">
              {hint
                ? t.rich('suggest.termHint', {
                    min: SEARCH_LIMITS.minTerm,
                    // The example is a token, so it is its own left-to-right run inside a right-to-left sentence.
                    code: (chunks) => (
                      <code dir="ltr" className="font-mono">
                        {chunks}
                      </code>
                    ),
                  })
                : t('syntaxHint')}
            </p>
          ))}
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
