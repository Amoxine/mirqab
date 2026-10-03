'use client';

import { useEffect } from 'react';
import { useSidebar } from 'fumadocs-ui/contexts/sidebar';
import { MOBILE_SIDEBAR_ID } from './docs-controls';

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Makes the mobile docs menu behave like the dialog it is while open: Escape closes it, the page
 * behind it (the content and the top bar) is inert so keyboard and screen readers stay inside, focus
 * moves in, and on close goes back to the button that opened it. Renders nothing.
 */
export function DocsDrawer() {
  const { open, setOpen } = useSidebar();

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const drawer = document.getElementById(MOBILE_SIDEBAR_ID);

    // Everything beside the drawer except the dimmed backdrop right before it, which closes it on click.
    const behind = [
      document.getElementById('nd-subnav'),
      ...[...(drawer?.parentElement?.children ?? [])].filter(
        (element) => element !== drawer && element !== drawer?.previousElementSibling,
      ),
    ].filter((element): element is HTMLElement => element instanceof HTMLElement);
    for (const element of behind) element.setAttribute('inert', '');

    // The drawer is `visibility: hidden` until Fumadocs' own re-render a moment after `open` flips, and a
    // hidden element cannot take focus: so focus moves in on the next frame. It lands on the drawer's close
    // button, not on the theme and language switches that come first in it.
    const frame = window.requestAnimationFrame(() => {
      (
        drawer?.querySelector<HTMLElement>(`button[aria-controls="${MOBILE_SIDEBAR_ID}"]`) ??
        drawer?.querySelector<HTMLElement>(FOCUSABLE)
      )?.focus();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
      for (const element of behind) element.removeAttribute('inert');
      opener?.focus();
    };
  }, [open, setOpen]);

  return null;
}
