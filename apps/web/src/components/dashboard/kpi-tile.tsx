'use client';

import Link from 'next/link';
import { KpiTile as BaseKpiTile, KpiTileSkeleton, type KpiTileProps } from '@open-gateway/ui';

export { KpiTileSkeleton, type KpiTileProps };

/** The shared tile; given an `href` it links through the app's own `Link` (a client-side navigation). */
export function KpiTile(props: Omit<KpiTileProps, 'linkComponent'>) {
  return <BaseKpiTile {...props} linkComponent={Link} />;
}
