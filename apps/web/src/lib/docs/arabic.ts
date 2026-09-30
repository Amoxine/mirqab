import { tokenizer as oramaTokenizer } from '@orama/orama/components';

/**
 * Arabic search normalisation for the docs. Orama's Arabic support is only a splitter (it splits on
 * anything outside the letters أ-ي) and no stemmer, which gave two visible failures:
 *  - a diacritic (U+064B-U+065F) is outside that range, so `المِفْتَاح` was cut into pieces at every mark;
 *  - the definite article was never removed, so `الوثائق` did not find a page that says `وثائق`.
 * The marks are removed BEFORE splitting (a stemmer runs too late), letter variants are folded, and a
 * light stemmer drops the article. The same tokenizer indexes and queries, so the two always agree.
 */

/** Short vowels, shadda, sukun, dagger alef (U+064B-U+065F, U+0670) and the tatweel (U+0640). */
const MARKS = /[ً-ٰٟـ]/g;

/** Folds the spellings people use interchangeably: alef with hamza or madda to bare alef, alef maqsura to ya, ta marbuta to ha. */
export function normalizeArabic(text: string): string {
  return text
    .replace(MARKS, '')
    .replace(/[آأإٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه');
}

/** The definite article, alone or after a one-letter preposition or conjunction (وال, فال, بال, كال, لل). */
const ARTICLE = /^(?:[وفبك]?ال|لل)/;
/** Never stem a word down to fewer than three letters: `ال` + 2 letters is usually a whole word. */
const MIN_STEM = 3;

/** A light stemmer: drops the article prefix only. Expects an already normalised token. */
export function stemArabicToken(token: string): string {
  const stem = token.replace(ARTICLE, '');
  return stem.length >= MIN_STEM ? stem : token;
}

/** Orama tokenizer for the docs' Arabic index: normalise, split, stem. */
export function createArabicTokenizer(): ReturnType<typeof oramaTokenizer.createTokenizer> {
  const tokenizer = oramaTokenizer.createTokenizer({ language: 'arabic', stemming: true, stemmer: stemArabicToken });
  const tokenize = tokenizer.tokenize.bind(tokenizer);
  // Orama calls `tokenize(input, language, property, withCache)`; normalising the input first is the only
  // way to remove marks before the splitter sees them.
  tokenizer.tokenize = (input, language, prop, withCache) => tokenize(typeof input === 'string' ? normalizeArabic(input) : input, language, prop, withCache);
  return tokenizer;
}
