'use client';

import { useEffect, useMemo, useRef } from 'react';
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

  // What the bar last asked the URL to become, until the URL shows it. A write takes a round trip (the
  // page renders again before the new URL is visible), and an entry made meanwhile must build on this and
  // not on the URL it has not caught up with: otherwise each of a few quick entries replaces the one before
  // and only the last survives. It is dropped once the URL equals it; if a navigation never lands it stays,
  // so the next write carries the chips that did not (the URL, not this, is what the chips show).
  const requested = useRef<string | null>(null);
  const current = searchParams.toString();
  useEffect(() => {
    if (requested.current === current) requested.current = null;
  }, [current]);

  /** Applies `edit` to the latest tokens and range (those asked for last, else those in the URL) and writes the result. */
  const update = (edit: (latest: string[], latestRange: AnalyticsRange) => { tokens: string[]; range: AnalyticsRange }) => {
    const params = new URLSearchParams(requested.current ?? current);
    const latestRange = RANGES.find((r) => r === params.get('range')) ?? DEFAULT_RANGE;
    const next = edit(tokenize(params.get('q') ?? ''), latestRange);
    if (next.tokens.length > 0) params.set('q', next.tokens.join(' '));
    else params.delete('q');
    if (next.range === DEFAULT_RANGE) params.delete('range');
    else params.set('range', next.range);
    const query = params.toString();
    requested.current = query === current ? null : query;
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  return {
    range,
    tokens,
    clauses,
    tooMany,
    /** Searching is allowed: every chip is understood and the caps hold. */
    ready: !hasError && tooMany === null,
    add: (text: string) => {
      update((latest, latestRange) => ({ tokens: [...latest, ...tokenize(text)], range: latestRange }));
    },
    remove: (index: number) => {
      // By the chip's text, not its position: while an earlier write is in flight the chips shown are the
      // older ones, and their positions are not the latest list's.
      const text = tokens[index]?.text;
      update((latest, latestRange) => {
        const at = text === undefined ? -1 : latest.indexOf(text);
        return { tokens: latest.filter((_, i) => i !== at), range: latestRange };
      });
    },
    setRange: (next: AnalyticsRange) => {
      update((latest) => ({ tokens: latest, range: next }));
    },
    replaceAll: (text: string) => {
      update((_, latestRange) => ({ tokens: tokenize(text), range: latestRange }));
    },
  };
}
