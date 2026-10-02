import { BrandMark } from '@/components/layout/brand-mark';

/**
 * The mark above every sign-in card (dashboard `/auth/*` and portal `/portal/auth/*`), standing in for
 * the brand name as visible text. It sits inside the page's one `<h1>`, so the heading is named by the
 * logo's alt and read once. Takes the name as a prop because both layouts that use it are server
 * components that resolve it themselves.
 *
 * The mark is fixed teal (#087482). Measured, it is 5.24:1 on the light background and 3.26:1 on the
 * dark background token, falling to ~3.0:1 at the dark page gradient's midpoint and 2.79:1 at its far
 * corner. WCAG 1.4.11 exempts logos and brand marks, so there is no badge behind it; the numbers are
 * here so that a change to the gradient or to the mark's colour is made knowing them.
 */
export function AuthBrand({ name }: { name: string }) {
  return (
    <h1 className="flex justify-center">
      <BrandMark alt={name} priority className="size-16 sm:size-20" />
    </h1>
  );
}
