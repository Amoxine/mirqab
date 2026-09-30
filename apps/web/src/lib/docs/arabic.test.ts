import { create, insert, search } from '@orama/orama';
import { tokenizer as oramaTokenizer } from '@orama/orama/components';
import { describe, expect, it } from 'vitest';
import { createArabicTokenizer, normalizeArabic, stemArabicToken } from './arabic';

describe('normalizeArabic', () => {
  it('removes short vowels, shadda, sukun, dagger alef and tatweel', () => {
    expect(normalizeArabic('المِفْتَاح')).toBe('المفتاح');
    expect(normalizeArabic('مُحَمَّد')).toBe('محمد');
    expect(normalizeArabic('كـــتاب')).toBe('كتاب');
  });

  it('folds alef, alef maqsura and ta marbuta variants', () => {
    expect(normalizeArabic('أحمد إبراهيم آمن')).toBe('احمد ابراهيم امن');
    expect(normalizeArabic('مستوى')).toBe('مستوي');
    expect(normalizeArabic('وثيقة')).toBe('وثيقه');
  });

  it('leaves Latin text and digits untouched', () => {
    expect(normalizeArabic('API v2 MIRQAB')).toBe('API v2 MIRQAB');
  });
});

describe('stemArabicToken', () => {
  it.each([
    ['الوثائق', 'وثائق'],
    ['والوثائق', 'وثائق'],
    ['بالطلب', 'طلب'],
    ['للطلب', 'طلب'],
    ['وثائق', 'وثائق'],
  ])('%s -> %s', (token, stem) => {
    expect(stemArabicToken(token)).toBe(stem);
  });

  it('never stems a word below three letters', () => {
    expect(stemArabicToken('التر')).toBe('التر'); // would be 'تر'
    expect(stemArabicToken('ال')).toBe('ال');
  });
});

describe('the Arabic tokenizer in a real Orama index', () => {
  async function index() {
    const db = create({ schema: { content: 'string' }, components: { tokenizer: createArabicTokenizer() } });
    await insert(db, { content: 'وثائق MIRQAB: مسار الطلب عبر البوابة' });
    await insert(db, { content: 'المِفْتَاح الجديد للتطبيق' });
    await insert(db, { content: 'صفحة أخرى بلا علاقة' });
    return db;
  }
  const hits = async (db: Awaited<ReturnType<typeof index>>, term: string) => (await search(db, { term })).count;

  it.each([
    ['وثائق', 1],
    ['الوثائق', 1], // with the article: was 0
    ['والوثائق', 1],
    ['الطلب', 1],
    ['طلب', 1],
    ['للطلب', 1],
    ['المفتاح', 1],
    ['مفتاح', 1],
    ['المِفْتَاح', 1], // with marks: was split into fragments and matched too broadly
    ['مفتَاح', 1],
    ['الجديد', 1],
    ['غيرموجود', 0],
  ])('%s finds %i page(s)', async (term, expected) => {
    expect(await hits(await index(), term)).toBe(expected);
  });

  it('a marked query no longer matches pages it should not (it was 17 results for 3 pages)', async () => {
    const db = await index();
    const hit = await search(db, { term: 'المِفْتَاح' });
    expect(hit.hits.map((h) => h.document.content)).toEqual(['المِفْتَاح الجديد للتطبيق']);
  });

  it('control: the stock Orama Arabic index has the failures this tokenizer fixes', async () => {
    const stock = create({ schema: { content: 'string' }, language: 'arabic' });
    await insert(stock, { content: 'وثائق MIRQAB: مسار الطلب عبر البوابة' });
    await insert(stock, { content: 'المِفْتَاح الجديد للتطبيق' });
    await insert(stock, { content: 'صفحة أخرى بلا علاقة' });
    expect((await search(stock, { term: 'الوثائق' })).count).toBe(0); // the article hides the page
  });

  it('control: the stock tokenizer cuts a word with marks into fragments, ours keeps it whole', () => {
    const stock = oramaTokenizer.createTokenizer({ language: 'arabic' });
    expect(stock.tokenize('المِفْتَاح', 'arabic')).toEqual(['الم', 'ف', 'ت', 'اح']);
    expect(createArabicTokenizer().tokenize('المِفْتَاح', 'arabic')).toEqual(['مفتاح']);
  });
});
