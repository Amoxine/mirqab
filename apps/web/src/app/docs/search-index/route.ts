import { createFromSource } from 'fumadocs-core/search/server';
import { source } from '@/lib/docs/source';

// Local Orama index built from the page loader; no external service. The client sends `?locale=`
// (taken from the same cookie-derived locale in the layout). `language: 'arabic'`/'french'
// enable the stemmers Orama ships; anything else uses the default multilingual segmenter.
export const { GET } = createFromSource(source, {
  localeMap: {
    en: { language: 'english' },
    fr: { language: 'french' },
    ar: { language: 'arabic' },
  },
});
