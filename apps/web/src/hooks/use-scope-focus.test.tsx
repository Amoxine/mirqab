// @vitest-environment jsdom
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import dashboard from '@/messages/en/dashboard.json';
import { ScopeChip } from '@/components/dashboard/scope-chip';
import { renderApp } from '@/components/dashboard/test-render';
import type { ApiDefinition } from '@/hooks/use-apis';
import type { DashboardScope } from '@/hooks/use-dashboard-scope';
import { useScopeFocus } from './use-scope-focus';

// The hook reads only the id and name of the scoped API, so a full ApiDefinition is not worth building.
const api = (id: string, name: string) => ({ id, name }) as unknown as ApiDefinition;

function Harness({ start = null, auto = false }: { start?: string | null; auto?: boolean }) {
  const [picked, setPicked] = useState(start);
  const scope: DashboardScope = {
    api: picked ? api(picked, 'Orders API') : null,
    auto,
    select: setPicked,
    clear: () => {
      setPicked(null);
    },
  };
  const focus = useScopeFocus(scope);
  return (
    <>
      <button type="button" onClick={() => { focus.select('a1'); }}>
        {'Show only Orders API'}
      </button>
      {scope.api && !scope.auto && <ScopeChip name={scope.api.name} onClear={focus.clear} clearRef={focus.chipRef} />}
      {/* The browser's Back and Forward: the scope changes in the URL without going through the hook. */}
      <button type="button" onClick={() => { setPicked(null); }}>
        {'Back'}
      </button>
      <button type="button" onClick={() => { setPicked('a1'); }}>
        {'Forward'}
      </button>
      <p role="status">{focus.announcement}</p>
    </>
  );
}

describe('useScopeFocus', () => {
  it('moves focus to the chip’s clear button when an API is picked, and says what the dashboard now shows', () => {
    renderApp(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Show only Orders API' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: dashboard.scope.clear }));
    expect(screen.getByRole('status').textContent).toBe('Showing only Orders API');
  });

  it('does not take focus for a scope that was already in the URL when the page opened', () => {
    renderApp(<Harness start="a1" />);
    expect(document.activeElement).toBe(document.body);
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('does nothing for the automatic scope of a gateway with one API (there is no chip to move to)', () => {
    renderApp(<Harness auto />);
    fireEvent.click(screen.getByRole('button', { name: 'Show only Orders API' }));
    expect(screen.queryByRole('button', { name: dashboard.scope.clear })).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('stops saying it once the scope is cleared', () => {
    renderApp(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Show only Orders API' }));
    fireEvent.click(screen.getByRole('button', { name: dashboard.scope.clear }));
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('does not take focus again for a later change it did not start (Back, then Forward to a scope with a chip)', () => {
    renderApp(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Show only Orders API' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: dashboard.scope.clear }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    const forward = screen.getByRole('button', { name: 'Forward' });
    forward.focus();
    fireEvent.click(forward);
    // The chip is back, but the person did not just pick it: focus stays where they were.
    expect(screen.getByRole('button', { name: dashboard.scope.clear })).toBeDefined();
    expect(document.activeElement).toBe(forward);
  });
});
