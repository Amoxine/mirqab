// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Button } from './button';

afterEach(cleanup);

describe('Button loading', () => {
  it('disables the button and marks it busy while loading, keeping its accessible name', () => {
    render(<Button loading>{'Save'}</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });

  it('is an ordinary enabled button when not loading', () => {
    render(<Button>{'Save'}</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(button.hasAttribute('aria-busy')).toBe(false);
  });

  it('stays disabled when the caller disables it, whatever `loading` says', () => {
    render(<Button disabled loading={false}>{'Save'}</Button>);
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
  });

  it('renders its single child as-is with asChild (no spinner sibling for Slot to choke on)', () => {
    render(
      <Button asChild loading>
        <a href="/x">{'Go'}</a>
      </Button>,
    );
    expect(screen.getByRole('link', { name: 'Go' }).querySelector('svg')).toBeNull();
  });
});
