// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CopyButton, RevealDialog } from '@open-gateway/ui';

const writeText = vi.fn();
afterEach(() => {
  writeText.mockReset();
});

function stubClipboard(result: 'ok' | 'fail') {
  writeText.mockImplementation(() =>
    result === 'ok' ? Promise.resolve() : Promise.reject(new Error('denied')),
  );
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

describe('CopyButton', () => {
  it('copies the value and confirms with the copied label', async () => {
    stubClipboard('ok');
    render(<CopyButton value="secret-1" label="Copy" copiedLabel="Copied" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('secret-1');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('reports a refused write through onCopyError and does not claim it copied', async () => {
    stubClipboard('fail');
    const onCopyError = vi.fn();
    render(<CopyButton value="x" label="Copy" copiedLabel="Copied" onCopyError={onCopyError} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => {
      expect(onCopyError).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
  });

  it('forgets it copied when the value changes (a new key is not "already copied")', async () => {
    stubClipboard('ok');
    const { rerender } = render(<CopyButton value="one" label="Copy" copiedLabel="Copied" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await screen.findByRole('button', { name: 'Copied' });
    rerender(<CopyButton value="two" label="Copy" copiedLabel="Copied" />);
    expect(await screen.findByRole('button', { name: 'Copy' })).toBeTruthy();
  });

  it('icon-only mode uses the label as its accessible name', () => {
    stubClipboard('ok');
    render(<CopyButton value="x" label="Copy instructions" iconOnly />);
    expect(screen.getByRole('button', { name: 'Copy instructions' })).toBeTruthy();
  });
});

describe('RevealDialog', () => {
  const props = {
    title: 'Copy your key',
    description: 'Shown once.',
    copyLabel: 'Copy',
    copiedLabel: 'Copied',
    doneLabel: 'Done',
    closeLabel: 'Close',
  };

  it('is closed for a null value and shows the value (with its test id) otherwise', () => {
    const { rerender } = render(<RevealDialog value={null} onClose={vi.fn()} {...props} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(
      <RevealDialog value="og_key_123" onClose={vi.fn()} valueTestId="the-key" {...props} />,
    );
    expect(screen.getByTestId('the-key').textContent).toBe('og_key_123');
  });

  it('closes through Done', () => {
    const onClose = vi.fn();
    render(<RevealDialog value="abc" onClose={onClose} {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
