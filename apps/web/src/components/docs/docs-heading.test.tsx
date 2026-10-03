// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { getMDXComponents } from './mdx-components';

afterEach(cleanup);

describe('docs headings', () => {
  const H3 = getMDXComponents().h3 as (props: { id?: string; children: string }) => React.ReactNode;

  it('are their own anchor link, and the decorative link icon has no English label', () => {
    const { container } = render(<>{H3({ id: 'what-callers-see', children: 'Ce que voient les appelants' })}</>);

    expect(screen.getByRole('heading', { level: 3 }).id).toBe('what-callers-see');
    expect(screen.getByRole('link', { name: 'Ce que voient les appelants' }).getAttribute('href')).toBe('#what-callers-see');
    expect(container.querySelector('[aria-label]')).toBeNull();
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('is a plain heading when it has no id', () => {
    render(<>{H3({ children: 'Plain' })}</>);

    expect(screen.getByRole('heading', { level: 3, name: 'Plain' })).toBeDefined();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
