import type { AdvancedOptions } from 'fumadocs-core/search/server';
import { createArabicTokenizer } from './arabic';

/**
 * How the docs search index treats each locale (`createFromSource`'s `localeMap`). Here, and not inline in the route, so a
 * test can build the very index the route builds: this is where it broke once (`language: 'arabic'` next to the custom
 * tokenizer: Orama refuses the pair, the index failed to build and docs search answered 500 in Arabic only).
 *
 * `language: 'english'`/`'french'` switch on the stemmers Orama ships. Orama's Arabic support is only a splitter, so
 * Arabic gets `arabic.ts` instead: it normalises marks and letter variants and drops the article. It carries its own
 * language, so NO `language` here: Orama refuses both (NO_LANGUAGE_WITH_CUSTOM_TOKENIZER).
 */
export const docsSearchLocaleMap: Record<string, Partial<AdvancedOptions>> = {
  en: { language: 'english' },
  fr: { language: 'french' },
  ar: { tokenizer: createArabicTokenizer() },
};
