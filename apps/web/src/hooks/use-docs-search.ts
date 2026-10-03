import { useQuery } from '@tanstack/react-query';
import { useLocale } from 'next-intl';
import { useDebouncedValue } from '@/hooks/use-debounced-value';

export interface DocsHit {
  url: string;
  title: string;
  /** Where in the docs the hit sits (section path), for the secondary line. */
  trail: string;
}

/** One line of Fumadocs' search answer (`/docs/search-index`): a page, one of its headings, or a passage. */
interface RawHit {
  type?: string;
  content?: string;
  url?: string;
  breadcrumbs?: string[];
}

const MIN_CHARS = 2;
const MAX_HITS = 6;

/** The documentation's own local search (`/docs/search-index`), in the UI language, one hit per page section. */
export function useDocsSearch(query: string) {
  const locale = useLocale();
  const term = useDebouncedValue(query.trim(), 250);
  return useQuery({
    queryKey: ['docs-search', locale, term],
    enabled: term.length >= MIN_CHARS,
    staleTime: 60_000,
    retry: false,
    queryFn: async (): Promise<DocsHit[]> => {
      const res = await fetch(`/docs/search-index?locale=${encodeURIComponent(locale)}&query=${encodeURIComponent(term)}`, {
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(`docs search ${String(res.status)}`);
      const raw = (await res.json()) as RawHit[];
      const seen = new Set<string>();
      const hits: DocsHit[] = [];
      // Fumadocs lists a page, then the headings and passages of it that matched; only the page carries its
      // breadcrumbs, so the others take the page's name as their trail ("which page is this heading on?").
      let page: RawHit | undefined;
      for (const r of Array.isArray(raw) ? raw : []) {
        if (r.type === 'page') page = r;
        if (!r.url || !r.content || seen.has(r.url)) continue;
        seen.add(r.url);
        const trail = r.breadcrumbs?.length || r.type === 'page' || !page ? (r.breadcrumbs ?? []) : [...(page.breadcrumbs ?? []), page.content ?? ''];
        hits.push({ url: r.url, title: r.content, trail: trail.filter(Boolean).join(' › ') });
        if (hits.length === MAX_HITS) break;
      }
      return hits;
    },
  });
}
