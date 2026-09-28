import { csvCell } from './csv';

// Moved out of audit.service.spec.ts alongside the function itself (see csv.ts's own comment):
// AuditService importing AnalyticsService (V1-LOG-01) turned the old cross-import into a real cycle.
describe('csvCell', () => {
  it('quotes every field', () => {
    expect(csvCell('apis')).toBe('"apis"');
  });

  it('escapes embedded quotes by doubling them (RFC4180)', () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it.each([[','], ['\n'], ['\r\n']])('keeps %p inside the quoted field', (char) => {
    expect(csvCell(`a${char}b`)).toBe(`"a${char}b"`);
  });

  // A cell starting with one of these is executed as a formula by Excel/Sheets.
  it.each([
    ['=1+1', `"'=1+1"`],
    ['+1', `"'+1"`],
    ['-1', `"'-1"`],
    ['@SUM(A1)', `"'@SUM(A1)"`],
    ['=cmd|\' /c calc\'!A0', `"'=cmd|' /c calc'!A0"`],
  ])('neutralises the formula %s', (raw, expected) => {
    expect(csvCell(raw)).toBe(expected);
  });

  it.each([[null], [undefined]])('renders %p as an empty quoted field', (value) => {
    expect(csvCell(value)).toBe('""');
  });
});
