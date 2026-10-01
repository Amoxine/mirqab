/** The selectable brand colours; the values live in globals.css (`[data-brand=…]`). Teal is the logo's. */
export const BRANDS = ['teal', 'blue', 'indigo', 'violet', 'fuchsia', 'slate'] as const;
export type Brand = (typeof BRANDS)[number];

export const DEFAULT_BRAND: Brand = 'teal';
/** Read by app/layout.tsx on the server, so the first paint is already in the chosen colour. */
export const BRAND_COOKIE = 'brand';

export const isBrand = (value: unknown): value is Brand => BRANDS.includes(value as Brand);

/** Applies a brand at once (no reload) and remembers it for a year. */
export function applyBrand(brand: Brand): void {
  document.documentElement.dataset.brand = brand;
  document.cookie = `${BRAND_COOKIE}=${brand}; path=/; max-age=31536000; samesite=lax`;
}
