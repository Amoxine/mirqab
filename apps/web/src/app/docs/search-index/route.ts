import { createFromSource } from 'fumadocs-core/search/server';
import { docsSearchLocaleMap } from '@/lib/docs/search-locales';
import { source } from '@/lib/docs/source';

// Local Orama index built from the page loader; no external service. The client sends `?locale=`
// (taken from the same cookie-derived locale in the layout). Each locale's treatment, and why Arabic carries
// no `language`, is in `lib/docs/search-locales.ts`, where a test builds the same index.
export const { GET } = createFromSource(source, { localeMap: docsSearchLocaleMap });
