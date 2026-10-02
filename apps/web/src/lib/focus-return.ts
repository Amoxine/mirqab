/**
 * Where focus goes when a sheet closes. A sheet opened by clicking a row's text has no trigger for the
 * browser to hand focus back to, and stepping to the next result moves "the row it belongs to" under it,
 * so the sheet puts focus on the control of the row that is open now: an element marked
 * `data-focus-return="<key>"`. If that row is gone (the list changed while the sheet was open), focus
 * goes to the page's main content, so it is never left on a hidden or removed element.
 */
export function focusReturn(key: string | null): void {
  // Compared as strings rather than put in a selector, so no key needs escaping.
  const opener =
    key === null
      ? undefined
      : Array.from(document.querySelectorAll<HTMLElement>('[data-focus-return]')).find(
          (el) => el.dataset.focusReturn === key,
        );
  (opener ?? document.getElementById('main-content'))?.focus();
}
