'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { TrafficSearchItem } from '@/hooks/use-traffic-search';
import { parseSearchTarget, withSearchTarget, type SearchTarget } from '@/lib/search-target';
import { tokenize } from '@/lib/traffic-search';

/** The part of the search bar's state this needs: what it holds now, and how to replace it. */
interface SearchBar {
  tokens: readonly { text: string }[];
  replaceAll: (text: string) => void;
}

/**
 * Which captured request the search page has open, kept in the URL (`?req=<id>&ts=<ts>`) so the
 * address is a shareable link to it, and so a link opens it even when it is not on the loaded page.
 * Opening, stepping and closing replace the history entry (like the search itself does), so the back
 * button leaves the page rather than walking through every request that was looked at.
 *
 * `items` are the loaded results, in order: they say where the open request sits and what its
 * neighbours are (none when it is not among them). `search` is the search bar, for `addFilter`.
 */
export function useOpenRequest(items: readonly TrafficSearchItem[], search: SearchBar) {
  const router = useRouter();
  const pathname = usePathname();
  const query = useSearchParams().toString();
  const target = useMemo(() => parseSearchTarget(new URLSearchParams(query)), [query]);

  /** The page's address with `next` open (or none open): the current search and range kept, `req` and `ts` set once. */
  const hrefFor = useCallback(
    (next: SearchTarget | null) => {
      const params = withSearchTarget(new URLSearchParams(query), next).toString();
      return params ? `${pathname}?${params}` : pathname;
    },
    [pathname, query],
  );
  const write = useCallback(
    (next: SearchTarget | null) => {
      router.replace(hrefFor(next), { scroll: false });
    },
    [hrefFor, router],
  );

  // A filter added from the open request changes the search under the sheet: the sheet should then
  // close so the new results are what the person sees. Closing in the same breath would race the
  // search's own URL write (both start from the same URL), so this waits for the search it asked for to
  // show up in the URL, then closes from that URL. It is the search TEXT it waits for, so a change of
  // anything else does not count, and it is forgotten if the sheet is closed another way meanwhile.
  const awaited = useRef<string | null>(null);
  useEffect(() => {
    if (awaited.current === null) return;
    if (target === null) {
      awaited.current = null;
      return;
    }
    if ((new URLSearchParams(query).get('q') ?? '') === awaited.current) {
      awaited.current = null;
      write(null);
    }
  }, [query, target, write]);

  /**
   * Adds a filter to the search. Built on the search it has just asked for when that has not reached the
   * URL yet, so two filters added in quick succession both land (the second would otherwise start from
   * the same stale search as the first and replace it). Nothing changes for a filter already there.
   */
  const addFilter = (text: string) => {
    const held = tokenize(awaited.current ?? search.tokens.map((token) => token.text).join(' '));
    const added = tokenize(text).filter((token) => !held.includes(token));
    if (added.length === 0) return;
    const next = [...held, ...added].join(' ');
    awaited.current = next;
    search.replaceAll(next);
  };

  const index = target ? items.findIndex((item) => item.id === target.id && item.ts === target.ts) : -1;

  return {
    target,
    listItem: index >= 0 ? items[index] : undefined,
    previous: index > 0 ? items[index - 1] : undefined,
    next: index >= 0 ? items[index + 1] : undefined,
    position: index >= 0 ? { index: index + 1, count: items.length } : undefined,
    open: (item: TrafficSearchItem) => {
      write({ id: item.id, ts: item.ts });
    },
    /** The link to `item` open: what `open` writes into the URL, for a new tab to load. */
    hrefTo: (item: TrafficSearchItem) => hrefFor({ id: item.id, ts: item.ts }),
    close: () => {
      write(null);
    },
    addFilter,
  };
}
