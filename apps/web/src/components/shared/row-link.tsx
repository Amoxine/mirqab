'use client';

import type { ComponentProps } from 'react';
import Link from 'next/link';
import {
  rowLinkProps,
  RowLink as BaseRowLink,
  StretchedLink as BaseStretchedLink,
} from '@open-gateway/ui';

/*
 * The package's whole-row and whole-tile links, bound to the app's own `Link` so a click is a
 * client-side navigation. See `RowLink` / `StretchedLink` in packages/ui for how they stay accessible.
 */
export { rowLinkProps };

/** A figure or a path that is itself a link: plain text until hovered or focused, then underlined or ringed. */
export const FIGURE_LINK =
  'rounded-sm hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring';

/**
 * The hidden link a row's click handler follows (`rowLinkProps` on the row), through next/link; the
 * row's own named link stays the keyboard target.
 */
export function RowLink(props: Omit<ComponentProps<typeof BaseRowLink>, 'linkComponent'>) {
  return <BaseRowLink {...props} linkComponent={Link} />;
}

/** A focusable link whose click area is its whole tile or card; its text is its name. */
export function StretchedLink(props: Omit<ComponentProps<typeof BaseStretchedLink>, 'linkComponent'>) {
  return <BaseStretchedLink {...props} linkComponent={Link} />;
}
