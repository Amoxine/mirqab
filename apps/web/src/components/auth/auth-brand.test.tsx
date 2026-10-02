// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AuthBrand } from './auth-brand';

afterEach(cleanup);

describe('AuthBrand', () => {
  it('is one heading whose name is the logo, with no brand text on screen', () => {
    render(<AuthBrand name="MIRQAB Developer Portal" />);

    // One h1, named by the image's alt: read once, not as a heading plus a separate image.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const heading = screen.getByRole('heading', { level: 1, name: 'MIRQAB Developer Portal' });
    const logo = screen.getByRole('img', { name: 'MIRQAB Developer Portal' });
    expect(heading.contains(logo)).toBe(true);

    expect(logo.getAttribute('src')).toContain('logo.svg');
    // Above the fold on every auth page: it must not be lazy-loaded.
    expect(logo.getAttribute('loading')).not.toBe('lazy');

    // Nothing to read on screen: the name lives only in the alt.
    expect(document.body.textContent).toBe('');
  });
});
