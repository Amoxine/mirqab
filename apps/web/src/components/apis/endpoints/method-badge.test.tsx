// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MethodBadge } from './method-badge';

const chip = (method: string) => screen.getByText(method).className;

describe('MethodBadge', () => {
  it('paints each HTTP verb in its own colour', () => {
    const { rerender } = render(<MethodBadge method="get" />);
    expect(chip('GET')).toContain('bg-success');

    rerender(<MethodBadge method="POST" />);
    expect(chip('POST')).toContain('bg-info');

    rerender(<MethodBadge method="put" />);
    expect(chip('PUT')).toContain('bg-warning');

    rerender(<MethodBadge method="patch" />);
    expect(chip('PATCH')).toContain('bg-patch');

    rerender(<MethodBadge method="delete" />);
    expect(chip('DELETE')).toContain('bg-destructive');

    rerender(<MethodBadge method="head" />);
    expect(chip('HEAD')).toContain('bg-primary');

    rerender(<MethodBadge method="options" />);
    expect(chip('OPTIONS')).toContain('bg-muted');

    rerender(<MethodBadge method="trace" />);
    expect(chip('TRACE')).toContain('bg-muted');

    rerender(<MethodBadge method="connect" />);
    expect(chip('CONNECT')).toContain('bg-muted');

    rerender(<MethodBadge method="nope" />);
    expect(chip('NOPE')).toContain('bg-muted');
  });
});
