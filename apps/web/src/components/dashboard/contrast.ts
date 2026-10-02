// Shared by the contrast tests (recent activity, the traffic tables): not a test file itself.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The app's stylesheet. Vitest runs from the app's own directory (`pnpm --filter @open-gateway/web …`), as the other file-reading tests assume. */
export const css = readFileSync(join(process.cwd(), 'src/styles/globals.css'), 'utf8');

/** Every `#rrggbb` value a token takes in the file, in order: the light theme's first, the dark theme's second. */
export const tokenValues = (name: string): string[] =>
  [...css.matchAll(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`, 'g'))].map((m) => m[1] ?? '');

export type Rgb = [number, number, number];
export const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const channel = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]: Rgb) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
/** `fg` at `alpha` over `bg`. */
export const over = (fg: Rgb, bg: Rgb, alpha: number): Rgb =>
  fg.map((c, i) => Math.round(alpha * c + (1 - alpha) * (bg[i] ?? 0))) as Rgb;
/** WCAG contrast ratio of two opaque colours. */
export const ratio = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
};
