import { createFromSource } from 'fumadocs-core/search/server';
import { createArabicTokenizer } from '@/lib/docs/arabic';
import { source } from '@/lib/docs/source';

// Local Orama index built from the page loader; no external service. The client sends `?locale=`
// (taken from the same cookie-derived locale in the layout). `language: 'arabic'`/'french'
// enable the stemmers Orama ships; anything else uses the default multilingual segmenter.
export const { GET } = createFromSource(source, {
  localeMap: {
    en: { language: 'english' },
    fr: { language: 'french' },
    // Orama only splits Arabic; `arabic.ts` normalises marks and letter variants and drops the article.
    ar: { language: 'arabic', tokenizer: createArabicTokenizer() },
  },
});
