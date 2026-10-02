// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ROW_CLICK_DELAY_MS, RowLink, onRowClick, passToRowLink, rowLinkProps } from '@open-gateway/ui';

interface Seen {
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

/** A table row the way every list renders one: copyable text, a named link, a button and a hidden row link. */
function Row({ href = '/target' }: { href?: string | null }) {
  return (
    <table>
      <tbody>
        <tr data-testid="row" {...rowLinkProps()}>
          <td>
            {href !== null && <RowLink href={href} />}
            <a href="/named" data-testid="named">
              {'Orders'}
            </a>
          </td>
          <td data-testid="slug">{'orders-api-slug'}</td>
          <td>
            <button type="button" data-testid="menu">
              {'menu'}
            </button>
            <span tabIndex={0} data-testid="tip">
              {'FAILED'}
            </span>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

const anchor = () => document.querySelector<HTMLAnchorElement>('a[data-row-link]');

/** Records every click that reaches the hidden row link, and stops jsdom from trying to navigate. */
function watchAnchor() {
  const seen: Seen[] = [];
  const el = anchor();
  if (!el) throw new Error('no row link');
  el.addEventListener('click', (event) => {
    seen.push({ ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey, alt: event.altKey });
    event.preventDefault();
  });
  return seen;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  vi.useRealTimers();
});

describe('the row link element', () => {
  it('is a real link to the row target that is not on the page: hidden, out of the tab order, unannounced', () => {
    render(<Row href="/apis/1" />);
    const el = anchor();
    expect(el?.getAttribute('href')).toBe('/apis/1');
    expect(el?.hasAttribute('hidden')).toBe(true);
    expect(el?.getAttribute('aria-hidden')).toBe('true');
    expect(el?.getAttribute('tabindex')).toBe('-1');
    // Nothing for a screen reader or the keyboard to land on: the row's own named link is the way in.
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual(['Orders']);
  });

  it('covers nothing: text in the row can be selected', () => {
    render(<Row />);
    expect(anchor()?.className ?? '').not.toContain('absolute');
  });
});

describe('a plain click on the row', () => {
  it('follows the row link once, after the double-click window and not before', () => {
    render(<Row />);
    const seen = watchAnchor();
    fireEvent.click(screen.getByTestId('slug'), { detail: 1 });
    vi.advanceTimersByTime(ROW_CLICK_DELAY_MS - 1);
    expect(seen).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ ctrl: false, meta: false, shift: false, alt: false });
    vi.advanceTimersByTime(5_000);
    expect(seen).toHaveLength(1);
  });

  it('does nothing for a double click: it is selecting a word', () => {
    render(<Row />);
    const seen = watchAnchor();
    const slug = screen.getByTestId('slug');
    fireEvent.click(slug, { detail: 1 });
    fireEvent.click(slug, { detail: 2 });
    vi.advanceTimersByTime(5_000);
    expect(seen).toHaveLength(0);
  });

  it('does nothing for a triple click: it is selecting a line', () => {
    render(<Row />);
    const seen = watchAnchor();
    const slug = screen.getByTestId('slug');
    fireEvent.click(slug, { detail: 1 });
    fireEvent.click(slug, { detail: 2 });
    fireEvent.click(slug, { detail: 3 });
    vi.advanceTimersByTime(5_000);
    expect(seen).toHaveLength(0);
  });

  it('does nothing when the click ends a text selection', () => {
    render(<Row />);
    const seen = watchAnchor();
    const slug = screen.getByTestId('slug');
    window.getSelection()?.selectAllChildren(slug);
    fireEvent.click(slug, { detail: 1 });
    vi.advanceTimersByTime(5_000);
    expect(seen).toHaveLength(0);
  });

  it('does nothing when text gets selected while it waits (a double click whose second click was slow)', () => {
    render(<Row />);
    const seen = watchAnchor();
    const slug = screen.getByTestId('slug');
    fireEvent.click(slug, { detail: 1 });
    window.getSelection()?.selectAllChildren(slug);
    vi.advanceTimersByTime(5_000);
    expect(seen).toHaveLength(0);
  });

  it.each([
    ['a button', 'menu'],
    ['the named link', 'named'],
    ['a focusable tooltip trigger', 'tip'],
  ])('leaves %s inside the row to itself', (_name, id) => {
    render(<Row />);
    const seen = watchAnchor();
    const control = screen.getByTestId(id);
    // The control's own click is not cancelled by the row: only the row's navigation is withheld.
    const own = vi.fn((event: Event) => {
      event.preventDefault();
    });
    control.addEventListener('click', own);
    fireEvent.click(control, { detail: 1 });
    vi.advanceTimersByTime(5_000);
    expect(own).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(0);
  });

  it('is withdrawn by a later click on a control, so the two actions never both happen', () => {
    render(<Row />);
    const seen = watchAnchor();
    fireEvent.click(screen.getByTestId('slug'), { detail: 1 });
    vi.advanceTimersByTime(ROW_CLICK_DELAY_MS - 50);
    fireEvent.click(screen.getByTestId('menu'), { detail: 1 });
    vi.advanceTimersByTime(5_000);
    expect(seen).toHaveLength(0);
  });

  it('a second plain click restarts the wait instead of opening twice', () => {
    render(<Row />);
    const seen = watchAnchor();
    const slug = screen.getByTestId('slug');
    fireEvent.click(slug, { detail: 1 });
    vi.advanceTimersByTime(ROW_CLICK_DELAY_MS - 50);
    fireEvent.click(slug, { detail: 1 });
    vi.advanceTimersByTime(5_000);
    expect(seen).toHaveLength(1);
  });

  it('does nothing, and does not throw, in a row that has no row link', () => {
    render(<Row href={null} />);
    fireEvent.click(screen.getByTestId('slug'), { detail: 1 });
    expect(() => vi.advanceTimersByTime(5_000)).not.toThrow();
  });

  // React itself drops a `click` with button 2, so button 1 is the one that proves the row's own guard.
  it.each([[1], [2]])('ignores a click made with button %i, which is not the primary button', (button) => {
    render(<Row />);
    const seen = watchAnchor();
    fireEvent.click(screen.getByTestId('slug'), { detail: 1, button });
    vi.advanceTimersByTime(5_000);
    expect(seen).toHaveLength(0);
  });
});

describe('a modified click on the row (a new tab or window, as on a real link)', () => {
  it.each([
    ['ctrlKey', { ctrl: true, meta: false, shift: false, alt: false }],
    ['metaKey', { ctrl: false, meta: true, shift: false, alt: false }],
    ['shiftKey', { ctrl: false, meta: false, shift: true, alt: false }],
    ['altKey', { ctrl: false, meta: false, shift: false, alt: true }],
  ])('%s goes to the row link at once, carrying the same modifier', (modifier, expected) => {
    render(<Row />);
    const seen = watchAnchor();
    fireEvent.click(screen.getByTestId('slug'), { detail: 1, [modifier]: true });
    // No waiting: nobody double-clicks with a modifier held, and a delay could lose the user gesture.
    expect(seen).toEqual([expected]);
    vi.advanceTimersByTime(5_000);
    expect(seen).toHaveLength(1);
  });

  it('leaves a modified click on a control inside the row alone', () => {
    render(<Row />);
    const seen = watchAnchor();
    fireEvent.click(screen.getByTestId('named'), { detail: 1, ctrlKey: true });
    expect(seen).toHaveLength(0);
  });

  it('a middle click opens it as a new tab would, whatever the platform’s modifier', () => {
    render(<Row />);
    const seen = watchAnchor();
    fireEvent(screen.getByTestId('slug'), new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    expect(seen).toEqual([{ ctrl: true, meta: true, shift: false, alt: false }]);
  });

  it('a right click does nothing (the browser shows its menu)', () => {
    render(<Row />);
    const seen = watchAnchor();
    fireEvent(screen.getByTestId('slug'), new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 }));
    expect(seen).toHaveLength(0);
  });

  it('a middle click on a control inside the row is left to the control', () => {
    render(<Row />);
    const seen = watchAnchor();
    fireEvent(screen.getByTestId('named'), new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    expect(seen).toHaveLength(0);
  });
});

describe('onRowClick (for a row that opens something other than a link)', () => {
  function Custom({ action }: { action: () => void }) {
    return (
      <table>
        <tbody>
          <tr
            data-testid="row"
            onClick={(event) => {
              onRowClick(event, action);
            }}
          >
            <td data-testid="cell">{'text'}</td>
            <td>
              <button type="button" data-testid="btn">
                {'go'}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    );
  }

  it('runs the action once for a plain click, after the double-click window', () => {
    const action = vi.fn();
    render(<Custom action={action} />);
    fireEvent.click(screen.getByTestId('cell'), { detail: 1 });
    expect(action).not.toHaveBeenCalled();
    vi.advanceTimersByTime(ROW_CLICK_DELAY_MS);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('does not run it for a double click, a selection or a control', () => {
    const action = vi.fn();
    render(<Custom action={action} />);
    const cell = screen.getByTestId('cell');
    fireEvent.click(cell, { detail: 1 });
    fireEvent.click(cell, { detail: 2 });
    window.getSelection()?.selectAllChildren(cell);
    fireEvent.click(cell, { detail: 1 });
    window.getSelection()?.removeAllRanges();
    fireEvent.click(screen.getByTestId('btn'), { detail: 1 });
    vi.advanceTimersByTime(5_000);
    expect(action).not.toHaveBeenCalled();
  });
});

describe('a row whose plain click does something else than follow its link (`rowLinkProps(…, action)`)', () => {
  const action = vi.fn();
  /** The row of a list that opens a sheet in place: its link is the sheet's address, and a button in it opens the same sheet. */
  function SheetRow() {
    return (
      <table>
        <tbody>
          <tr data-testid="row" {...rowLinkProps(undefined, action)}>
            <td>
              <RowLink href="/list?open=1" />
              <button
                type="button"
                data-testid="opener"
                onClick={(event) => {
                  if (!passToRowLink(event)) action();
                }}
                onAuxClick={(event) => {
                  passToRowLink(event);
                }}
              >
                {'time'}
              </button>
            </td>
            <td data-testid="slug">{'orders-api-slug'}</td>
          </tr>
        </tbody>
      </table>
    );
  }
  beforeEach(() => {
    action.mockClear();
  });

  it('runs the action for a plain click, after the double-click window, and does not follow the link', () => {
    render(<SheetRow />);
    const seen = watchAnchor();
    fireEvent.click(screen.getByTestId('slug'), { detail: 1 });
    expect(action).not.toHaveBeenCalled();
    vi.advanceTimersByTime(ROW_CLICK_DELAY_MS + 10);
    expect(action).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(0);
  });

  it('still passes a modified click on the row to the link, and runs no action', () => {
    render(<SheetRow />);
    const seen = watchAnchor();
    fireEvent.click(screen.getByTestId('slug'), { detail: 1, ctrlKey: true });
    vi.advanceTimersByTime(5_000);
    expect(seen).toEqual([{ ctrl: true, meta: false, shift: false, alt: false }]);
    expect(action).not.toHaveBeenCalled();
  });
});

describe('passToRowLink (a control inside the row that does the row\'s own action)', () => {
  function Host({ withLink = true }: { withLink?: boolean }) {
    let result: boolean | undefined;
    return (
      <div data-testid="host">
        {withLink && <RowLink href="/target" />}
        <button
          type="button"
          data-testid="button"
          onClick={(event) => {
            result = passToRowLink(event);
            document.body.dataset.passed = String(result);
          }}
          onAuxClick={(event) => {
            result = passToRowLink(event);
            document.body.dataset.passed = String(result);
          }}
        >
          {'open'}
        </button>
      </div>
    );
  }
  afterEach(() => {
    delete document.body.dataset.passed;
  });

  it.each([['ctrlKey'], ['metaKey'], ['shiftKey'], ['altKey']])('passes a %s click on with that modifier and says so', (modifier) => {
    render(<Host />);
    const seen = watchAnchor();
    fireEvent.click(screen.getByTestId('button'), { detail: 1, [modifier]: true });
    expect(document.body.dataset.passed).toBe('true');
    expect(seen).toEqual([{ ctrl: modifier === 'ctrlKey', meta: modifier === 'metaKey', shift: modifier === 'shiftKey', alt: modifier === 'altKey' }]);
  });

  it('passes a middle click on as Ctrl + Cmd, and says so', () => {
    render(<Host />);
    const seen = watchAnchor();
    fireEvent(screen.getByTestId('button'), new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    expect(document.body.dataset.passed).toBe('true');
    expect(seen).toEqual([{ ctrl: true, meta: true, shift: false, alt: false }]);
  });

  it('leaves a plain click and a right click to the control, and says it passed nothing', () => {
    render(<Host />);
    const seen = watchAnchor();
    fireEvent.click(screen.getByTestId('button'), { detail: 1 });
    expect(document.body.dataset.passed).toBe('false');
    fireEvent(screen.getByTestId('button'), new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 }));
    expect(document.body.dataset.passed).toBe('false');
    expect(seen).toEqual([]);
  });

  it('says it passed nothing when there is no row link to pass it to', () => {
    render(<Host withLink={false} />);
    fireEvent.click(screen.getByTestId('button'), { detail: 1, ctrlKey: true });
    expect(document.body.dataset.passed).toBe('false');
  });
});
