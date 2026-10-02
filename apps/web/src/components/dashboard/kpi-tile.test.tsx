// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Activity } from 'lucide-react';
import Link from 'next/link';
import { KpiTile } from './kpi-tile';

describe('KpiTile as a link', () => {
  it('is a plain tile without an href: no link at all', () => {
    render(<KpiTile label="Requests" value="12" />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('makes the tile one real link, named by its label, to the list behind the figure', () => {
    render(<KpiTile label="Requests" value="12" hint="last 24 hours" icon={Activity} href="/analytics/traffic?range=7d" />);
    const link = screen.getByRole('link', { name: 'Requests' });
    expect(link.getAttribute('href')).toBe('/analytics/traffic?range=7d');
    // One link per tile, not one per piece of text in it.
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('stretches that link over the whole tile, so the figure is clickable too', () => {
    const { container } = render(<KpiTile label="Requests" value="12" href="/analytics/traffic" />);
    const link = screen.getByRole('link', { name: 'Requests' });
    // The link's ::after covers the nearest positioned ancestor, which must be the tile itself.
    expect(link.className).toContain('after:absolute');
    expect(link.className).toContain('after:inset-0');
    const tile = container.firstElementChild;
    expect(tile?.className).toContain('relative');
    expect(tile?.contains(link)).toBe(true);
  });

  it('shows a keyboard focus ring on the link', () => {
    render(<KpiTile label="Requests" value="12" href="/analytics/traffic" />);
    expect(screen.getByRole('link', { name: 'Requests' }).className).toContain('focus-visible:after:ring-2');
  });

  it('lets a second link live in the hint, never nested inside the first', () => {
    const { container } = render(
      <KpiTile
        label="Active APIs"
        value="4"
        href="/apis"
        hint={
          <Link href="/keys" className="relative z-10">
            {'7 active keys'}
          </Link>
        }
      />,
    );
    expect(screen.getByRole('link', { name: 'Active APIs' }).getAttribute('href')).toBe('/apis');
    expect(screen.getByRole('link', { name: '7 active keys' }).getAttribute('href')).toBe('/keys');
    expect(container.querySelectorAll('a a')).toHaveLength(0);
  });
});
