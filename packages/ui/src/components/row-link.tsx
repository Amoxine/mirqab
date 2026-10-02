import type { AnchorHTMLAttributes, ComponentType, MouseEvent, ReactNode } from 'react';
import { cn } from '../lib/utils';

/**
 * What a link is rendered with. The package has no router, so the app passes its own `Link` (a click
 * is then a client-side navigation); left out, a plain `<a>` is used.
 */
export type LinkComponent = ComponentType<AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>;

function PlainAnchor(props: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return <a {...props} />;
}

/**
 * Whatever in a row does something of its own. A click on it is that control's, never the row's, and
 * a focusable element (a tooltip trigger) counts too.
 */
const CONTROL =
  'a, button, input, select, textarea, label, summary, [role="button"], [role="link"], [role="menuitem"], [role="checkbox"], [role="switch"], [role="tab"], [tabindex]:not([tabindex="-1"])';

/**
 * How long a plain click on a row waits before it acts. A double click (selecting a word) and a
 * triple click (selecting a line) begin with a plain click, so acting at once would take the user
 * away before the second click arrives; nothing can cancel a navigation once it has started.
 */
export const ROW_CLICK_DELAY_MS = 250;

const isControl = (target: EventTarget): boolean => target instanceof Element && target.closest(CONTROL) !== null;
const hasSelection = (): boolean => (window.getSelection()?.toString() ?? '') !== '';
const hasModifier = (event: MouseEvent): boolean => event.ctrlKey || event.metaKey || event.shiftKey || event.altKey;

/** The wait each row is in, so a later click can end it. */
const waiting = new WeakMap<Element, number>();
function stopWaiting(row: Element): void {
  window.clearTimeout(waiting.get(row));
  waiting.delete(row);
}

/**
 * The click handler of a row that acts when the row itself is clicked (opens a sheet, follows a link).
 * It acts only for a plain, primary-button click on the row's own space, after `ROW_CLICK_DELAY_MS`:
 * not for a click on a control inside it, not for the second or third click of a double or triple click,
 * not when text is selected (the end of a drag, or a word picked by a double click), and a later click
 * of any kind cancels a click still waiting. So the text in a row stays selectable and copyable.
 */
export function onRowClick(event: MouseEvent<HTMLElement>, action: () => void): void {
  const row = event.currentTarget;
  stopWaiting(row);
  if (event.detail > 1) return;
  if (event.button !== 0 || hasModifier(event) || isControl(event.target) || hasSelection()) return;
  waiting.set(
    row,
    window.setTimeout(() => {
      waiting.delete(row);
      if (!hasSelection()) action();
    }, ROW_CLICK_DELAY_MS),
  );
}

const rowAnchor = (row: HTMLElement): HTMLAnchorElement | null => row.querySelector<HTMLAnchorElement>('a[data-row-link]');

/**
 * A click on `anchor` as the browser would make it, carrying `modifiers` (a new tab for Ctrl or Cmd, a
 * window for Shift). `from` is the click that asked for it: its window is the new click's window.
 */
function clickAnchor(anchor: HTMLAnchorElement, from: MouseEvent, modifiers: MouseEventInit): void {
  anchor.dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true, view: from.nativeEvent.view, ...modifiers }),
  );
}

/**
 * Click on a row that has a `RowLink`: follow it. A plain click does (see `onRowClick`), through the
 * link's own component, so a client-side router navigates and prefetches as it does for any link. A
 * click with Ctrl, Cmd, Shift or Alt held is passed on to the link at once WITH those modifiers, so the
 * browser opens the new tab or window exactly as it would for the link itself.
 *
 * `action` replaces what a plain click does: for a row that opens something in place (a sheet, which the
 * URL names) while its link is the same thing's address, for the new tab.
 */
export function openRowLink(event: MouseEvent<HTMLElement>, action?: () => void): void {
  const anchor = rowAnchor(event.currentTarget);
  if (!anchor) return;
  if (hasModifier(event) && event.button === 0 && event.detail <= 1 && !isControl(event.target)) {
    stopWaiting(event.currentTarget);
    clickAnchor(anchor, event, {
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
    });
    return;
  }
  onRowClick(event, action ?? (() => {
    anchor.click();
  }));
}

/**
 * For a control inside a row that has a `RowLink` and does that row's own action (a button that opens the
 * same sheet): a click on it with Ctrl, Cmd, Shift or Alt held, or a middle click, is passed to the row's
 * link so the browser opens the new tab or window, exactly as it does for a click on the row's text.
 * Returns whether it did, so the control knows not to act in this tab as well.
 */
export function passToRowLink(event: MouseEvent<HTMLElement>): boolean {
  const middle = event.type === 'auxclick' && event.button === 1;
  const modified = event.type === 'click' && event.button === 0 && hasModifier(event);
  if (!middle && !modified) return false;
  let host = event.currentTarget.parentElement;
  while (host && !rowAnchor(host)) host = host.parentElement;
  const anchor = host ? rowAnchor(host) : null;
  if (!anchor) return false;
  clickAnchor(
    anchor,
    event,
    middle
      ? { ctrlKey: true, metaKey: true }
      : { ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey },
  );
  return true;
}

/** A middle click on a row with a `RowLink`: a new tab, as a middle click on the link would open. */
export function openRowLinkInNewTab(event: MouseEvent<HTMLElement>): void {
  if (event.button !== 1 || isControl(event.target)) return;
  const anchor = rowAnchor(event.currentTarget);
  // Both modifiers, because the one that means "new tab" is Ctrl on most systems and Cmd on a Mac.
  if (anchor) clickAnchor(anchor, event, { ctrlKey: true, metaKey: true });
}

/**
 * What a row with a `RowLink` spreads onto its `<tr>` (or card): the pointer cursor and the two handlers.
 * `action` is what a plain click does instead of following the link (see `openRowLink`).
 */
export function rowLinkProps(className?: string, action?: () => void) {
  return {
    className: cn('cursor-pointer', className),
    onClick: (event: MouseEvent<HTMLElement>) => {
      openRowLink(event, action);
    },
    onAuxClick: openRowLinkInNewTab,
  };
}

/**
 * The link a row with `rowLinkProps` follows when it is clicked. It is a real link, rendered by the
 * app's own link component, but it is hidden and takes no space: it exists to be followed by the row's
 * click handler, so the row's text is left alone and can be selected and copied.
 *
 * It is not for keyboards or assistive technology (out of the tab order, `aria-hidden`): the row's own
 * named link (the name, the path, the figure) is their way to the same place, so a row that uses this
 * must carry one. Put it in the row's first cell.
 */
export function RowLink({
  href,
  linkComponent: Link = PlainAnchor,
}: {
  href: string;
  linkComponent?: LinkComponent;
}) {
  return <Link href={href} data-row-link="" hidden tabIndex={-1} aria-hidden="true" />;
}

/**
 * The accessible way to make a whole tile or card one link: a normal, focusable link whose `::after`
 * is stretched over the nearest positioned ancestor, so the text is the link's name and the whole
 * surface is its click area. Anything else clickable inside the surface must be lifted above it
 * (`relative z-10`). `className` adjusts the focus ring's corners to the surface's.
 */
export function StretchedLink({
  href,
  linkComponent: Link = PlainAnchor,
  className,
  children,
}: {
  href: string;
  linkComponent?: LinkComponent;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'rounded-sm after:absolute after:inset-0 after:rounded-[inherit] focus-visible:outline-hidden focus-visible:after:ring-2 focus-visible:after:ring-ring',
        className,
      )}
    >
      {children}
    </Link>
  );
}
