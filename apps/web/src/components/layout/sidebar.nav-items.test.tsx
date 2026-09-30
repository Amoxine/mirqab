// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import nav from '@/messages/en/nav.json';
import { useNavItems } from './sidebar';

let granted: string[] = [];
vi.mock('next/navigation', () => ({ usePathname: () => '/' }));
vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: (p: string) => granted.includes(p), isLoading: false }),
}));

function Labels() {
  return (
    <ul>
      {useNavItems().map((item) => (
        <li key={item.href} data-href={item.href}>
          {item.label}
        </li>
      ))}
    </ul>
  );
}

const visible = () => Array.from(document.querySelectorAll('li')).map((li) => li.getAttribute('data-href'));

beforeEach(() => {
  granted = [];
});

describe('navigation entries', () => {
  const show = () =>
    render(
      <NextIntlClientProvider locale="en" messages={{ nav }}>
        <Labels />
      </NextIntlClientProvider>,
    );

  it('shows the request search only to someone holding BOTH analytics:read and api:update', () => {
    for (const held of [[], ['analytics:read'], ['api:update']]) {
      granted = held;
      const { unmount } = show();
      expect(visible()).not.toContain('/analytics/search');
      unmount();
    }
    granted = ['analytics:read', 'api:update'];
    show();
    expect(visible()).toContain('/analytics/search');
    expect(screen.getByText(nav.trafficSearch)).toBeDefined();
  });

  it('still shows single-permission entries by that one permission', () => {
    granted = ['analytics:read'];
    show();
    expect(visible()).toEqual(expect.arrayContaining(['/', '/analytics', '/analytics/traffic']));
    expect(visible()).not.toContain('/apis');
  });
});
