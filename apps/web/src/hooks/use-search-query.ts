'use client';

import { useCallback, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { SEARCH_LIMITS, parseToken, tokenize, type ParsedToken, type SearchClause } from '@/lib/traffic-search';
import type { AnalyticsRange } from '@/types';

const RANGES: readonly AnalyticsRange[] = ['1h', '24h', '7d', '30d'];
const DEFAULT_RANGE: AnalyticsRange = '24h';

export interface SearchToken {
  /** The text as typed, and as shown in its chip. */
  text: string;
  parsed: ParsedToken;
}

/**
 * The search bar's state, kept in the URL (`?q=status:>=500 body:"timeout"&range=7d`) so a search can
 * be shared and survives a reload. The chips are the tokens of `q`; there is no second copy to drift.
 */
export function useSearchQuery() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const q = searchParams.get('q') ?? '';
  const rangeParam = searchParams.get('range');
  const range = RANGES.find((r) => r === rangeParam) ?? DEFAULT_RANGE;

  const tokens = useMemo<SearchToken[]>(() => tokenize(q).map((text) => ({ text, parsed: parseToken(text) })), [q]);
  const clauses = useMemo<SearchClause[]>(
    () => tokens.flatMap((t) => (t.parsed.ok ? [t.parsed.clause] : [])),
    [tokens],
  );
  const hasError = tokens.some((t) => !t.parsed.ok);
  const bodyClauses = clauses.filter((c) => c.kind === 'body').length;
  const tooMany: 'clauses' | 'bodyClauses' | null =
    tokens.length > SEARCH_LIMITS.maxClauses ? 'clauses' : bodyClauses > SEARCH_LIMITS.maxBodyClauses ? 'bodyClauses' : null;

  const write = useCallback(
    (nextTokens: string[], nextRange: AnalyticsRange) => {
      const params = new URLSearchParams(searchParams.toString());
      if (nextTokens.length > 0) params.set('q', nextTokens.join(' '));
      else params.delete('q');
      if (nextRange === DEFAULT_RANGE) params.delete('range');
      else params.set('range', nextRange);
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  return {
    range,
    tokens,
    clauses,
    hasError,
    tooMany,
    /** Searching is allowed: every chip is understood and the caps hold. */
    ready: !hasError && tooMany === null,
    add: (text: string) => {
      write([...tokens.map((t) => t.text), ...tokenize(text)], range);
    },
    remove: (index: number) => {
      write(
        tokens.filter((_, i) => i !== index).map((t) => t.text),
        range,
      );
    },
    setRange: (next: AnalyticsRange) => {
      write(
        tokens.map((t) => t.text),
        next,
      );
    },
    replaceAll: (text: string) => {
      write(tokenize(text), range);
    },
  };
}
