// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConfirmDialog } from '@open-gateway/ui';

function setup(over: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="Delete thing"
      description="This cannot be undone."
      confirmLabel="Delete"
      pendingLabel="Deleting…"
      cancelLabel="Cancel"
      onConfirm={onConfirm}
      {...over}
    />,
  );
  return { onConfirm, onOpenChange };
}

describe('ConfirmDialog', () => {
  it('runs onConfirm and stays open: closing is the caller’s job once the work settles', () => {
    const { onConfirm, onOpenChange } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });

  it('cancels through onOpenChange(false)', () => {
    const { onOpenChange } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('while pending: shows the pending label, disables both buttons and refuses to be dismissed', () => {
    const { onOpenChange } = setup({ isPending: true });
    expect(screen.getByRole('button', { name: 'Deleting…' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true);
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('is destructive by default and neutral with tone="default"', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Delete' }).className).toContain('bg-destructive');
  });
});

describe('ConfirmDialog tone', () => {
  it('does not paint the confirm button red for a non-destructive confirmation', () => {
    setup({ tone: 'default' });
    expect(screen.getByRole('button', { name: 'Delete' }).className).not.toContain(
      'bg-destructive',
    );
  });
});
