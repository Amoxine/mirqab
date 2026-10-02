// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ChipInput, type ChipInputChip, type ChipInputSuggestion } from '@open-gateway/ui';

const labels = {
  input: 'Search filters',
  placeholder: 'status:>=500',
  remove: (text: string) => `Remove ${text}`,
  edit: (text: string) => `Edit ${text}`,
};
const chips: ChipInputChip[] = [
  { id: 'a', text: 'status:>=500' },
  { id: 'b', text: '-status:404', tone: 'negated' },
];

function setup(list: ChipInputChip[] = chips) {
  const onSubmit = vi.fn();
  const onRemove = vi.fn();
  render(<ChipInput chips={list} onSubmit={onSubmit} onRemove={onRemove} labels={labels} describedBy="why" />);
  return { onSubmit, onRemove, input: screen.getByLabelText<HTMLInputElement>('Search filters') };
}

describe('ChipInput', () => {
  it('submits the typed text on Enter and clears the field', () => {
    const { onSubmit, input } = setup();
    fireEvent.change(input, { target: { value: 'method:POST' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('method:POST');
    expect(input.value).toBe('');
  });

  it('ignores Enter on blank text, and Enter that confirms an IME composition', () => {
    const { onSubmit, input } = setup();
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'かな' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(input.value).toBe('かな');
  });

  it('removes the last chip on Backspace in an empty field, but not while text is being deleted', () => {
    const { onRemove, input } = setup();
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onRemove).toHaveBeenCalledWith('b');
  });

  it('removes a chip with its button', () => {
    const { onRemove } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Remove status:>=500' }));
    expect(onRemove).toHaveBeenCalledWith('a');
  });

  it('moves a chip back into the field to edit it', () => {
    const { onRemove, input } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Edit -status:404' }));
    expect(onRemove).toHaveBeenCalledWith('b');
    expect(input.value).toBe('-status:404');
  });

  it('shows the placeholder only while there are no chips, and points at its explanation', () => {
    const empty = setup([]);
    expect(empty.input.placeholder).toBe('status:>=500');
    expect(empty.input.getAttribute('aria-describedby')).toBe('why');
  });

  it('hides the placeholder once there are chips', () => {
    const { input } = setup();
    expect(input.placeholder).toBe('');
  });

  it('is a plain text field, not a combobox, without suggestions', () => {
    const { input } = setup();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(input.hasAttribute('aria-expanded')).toBe(false);
  });
});

const suggestLabels = {
  ...labels,
  suggestions: 'Filter suggestions',
  suggestionCount: (count: number) => `${String(count)} suggestions`,
};
const options: ChipInputSuggestion[] = [
  { id: 'status', label: 'status:', description: 'HTTP status code', apply: 'status:', match: { start: 0, end: 2 } },
  { id: 'method', label: 'method:', description: 'HTTP method', apply: 'method:' },
  { id: 'five', label: '5xx', description: 'Server error', apply: 'status:5xx', commit: true },
];

function setupSuggest(list: ChipInputSuggestion[] = options) {
  const onSubmit = vi.fn();
  const onRemove = vi.fn();
  const onDraftChange = vi.fn();
  render(
    <ChipInput
      chips={chips}
      onSubmit={onSubmit}
      onRemove={onRemove}
      onDraftChange={onDraftChange}
      suggestions={list}
      labels={suggestLabels}
    />,
  );
  const input = screen.getByRole<HTMLInputElement>('combobox', { name: 'Search filters' });
  const focus = () => {
    act(() => {
      input.focus();
    });
  };
  const rows = () => screen.queryAllByRole('option');
  return { onSubmit, onRemove, onDraftChange, input, focus, rows };
}

describe('ChipInput suggestions', () => {
  it('is a collapsed combobox until the field is focused, then lists the suggestions under a named listbox', () => {
    const { input, focus, rows } = setupSuggest();
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(screen.queryByRole('listbox')).toBeNull();

    focus();
    const listbox = screen.getByRole('listbox', { name: 'Filter suggestions' });
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-controls')).toBe(listbox.id);
    expect(rows().map((row) => row.textContent)).toEqual([
      'status:HTTP status code',
      'method:HTTP method',
      '5xxServer error',
    ]);
    // Focus stays in the field: the list is never in the tab order.
    expect(document.activeElement).toBe(input);
  });

  it('shows nothing, and says it is collapsed, while there is nothing to suggest', () => {
    const { input, focus } = setupSuggest([]);
    focus();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.hasAttribute('aria-controls')).toBe(false);
  });

  it('moves the highlight with the arrows, wrapping at both ends, and points aria-activedescendant at it', () => {
    const { input, focus, rows } = setupSuggest();
    focus();
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(rows()[0]?.id);
    expect(rows()[0]?.getAttribute('aria-selected')).toBe('true');
    expect(rows()[1]?.getAttribute('aria-selected')).toBe('false');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.getAttribute('aria-activedescendant')).toBe(rows()[2]?.id);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(rows()[0]?.id);
  });

  it('starts from the last row when ArrowUp is the first key pressed', () => {
    const { input, focus, rows } = setupSuggest();
    focus();
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.getAttribute('aria-activedescendant')).toBe(rows()[2]?.id);
  });

  it('puts a highlighted suggestion into the field on Enter without submitting, and reports the new text', () => {
    const { input, onSubmit, onDraftChange, focus } = setupSuggest();
    focus();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('status:');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onDraftChange).toHaveBeenLastCalledWith('status:');
    // Accepting a field keeps the list open for its values.
    expect(input.getAttribute('aria-expanded')).toBe('true');
  });

  it('submits a highlighted commit suggestion as a chip, clears the field and closes the list', () => {
    const { input, onSubmit, onDraftChange, focus } = setupSuggest();
    focus();
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('status:5xx');
    expect(input.value).toBe('');
    expect(onDraftChange).toHaveBeenLastCalledWith('');
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('still submits exactly what was typed on Enter when nothing was highlighted', () => {
    const { input, onSubmit, focus } = setupSuggest();
    focus();
    fireEvent.change(input, { target: { value: 'sta' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('sta');
    expect(input.value).toBe('');
  });

  it('forgets the highlight when the text changes, so Enter then submits the text', () => {
    const { input, onSubmit, focus } = setupSuggest();
    focus();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.change(input, { target: { value: 'stat' } });
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('stat');
  });

  it('accepts a row on Tab only when it was highlighted with the arrows, not the first one', () => {
    const { input, focus } = setupSuggest();
    focus();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(false);
    expect(input.value).toBe('method:');
  });

  it('lets Tab leave the field while rows are showing and none was highlighted: empty, with text, or after a trailing space', () => {
    const { input, onSubmit, focus } = setupSuggest();
    focus();
    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true);
    expect(input.value).toBe('');

    fireEvent.change(input, { target: { value: 'st' } });
    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true);
    expect(input.value).toBe('st');

    fireEvent.change(input, { target: { value: 'status:500 ' } });
    expect(screen.getByRole('listbox')).toBeDefined();
    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true);
    expect(input.value).toBe('status:500 ');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('lets Shift+Tab go back even when a row is highlighted', () => {
    const { input, focus } = setupSuggest();
    focus();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })).toBe(true);
    expect(input.value).toBe('');
  });

  it('closes on Escape, ignores a second Escape, and opens again when typing or pressing ArrowDown', () => {
    const { input, focus } = setupSuggest();
    focus();
    expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(false);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(true);

    fireEvent.change(input, { target: { value: 's' } });
    expect(screen.getByRole('listbox')).toBeDefined();

    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('listbox')).toBeDefined();
    expect(input.hasAttribute('aria-activedescendant')).toBe(true);
  });

  it('closes when the field loses focus', () => {
    const { input, focus } = setupSuggest();
    focus();
    fireEvent.blur(input);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('ignores the suggestion keys while an IME composition is in progress, and hides the list until it ends', () => {
    const { input, focus } = setupSuggest();
    focus();
    fireEvent.keyDown(input, { key: 'ArrowDown', isComposing: true });
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    fireEvent.change(input, { target: { value: 'st' } });
    expect(fireEvent.keyDown(input, { key: 'Tab', isComposing: true })).toBe(true);
    expect(input.value).toBe('st');

    fireEvent.compositionStart(input);
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.change(input, { target: { value: 'かな' } });
    fireEvent.compositionEnd(input);
    expect(screen.getByRole('listbox')).toBeDefined();
  });

  it('keeps focus in the field on mouse down, and accepts the row that was clicked', () => {
    const { input, onSubmit, onDraftChange, focus, rows } = setupSuggest();
    focus();
    const second = rows()[1];
    if (!second) throw new Error('expected a second row');
    expect(fireEvent.mouseDown(second)).toBe(false);
    expect(document.activeElement).toBe(input);

    fireEvent.click(second);
    expect(input.value).toBe('method:');
    expect(onDraftChange).toHaveBeenLastCalledWith('method:');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
  });

  it('submits a clicked commit row', () => {
    const { input, onSubmit, focus, rows } = setupSuggest();
    focus();
    const last = rows()[2];
    if (!last) throw new Error('expected a third row');
    fireEvent.click(last);
    expect(onSubmit).toHaveBeenCalledWith('status:5xx');
    expect(input.value).toBe('');
  });

  it('does not change the highlight on mouse hover, so a parked pointer cannot hijack Enter', () => {
    const { input, onSubmit, focus, rows } = setupSuggest();
    focus();
    const second = rows()[1];
    if (!second) throw new Error('expected a second row');
    fireEvent.mouseEnter(second);
    fireEvent.mouseMove(second);
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('x');
  });

  it('still removes the last chip on Backspace in an empty field while the list is open', () => {
    const { input, onRemove, focus } = setupSuggest();
    focus();
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onRemove).toHaveBeenCalledWith('b');
  });

  it('emphasises the part of the label that matched', () => {
    const { focus, rows } = setupSuggest();
    focus();
    const first = rows()[0];
    if (!first) throw new Error('expected a first row');
    expect(within(first).getByText('st').tagName).toBe('SPAN');
    expect(within(first).getByText('atus:')).toBeDefined();
  });

  it('announces how many suggestions are showing after a pause in typing, and nothing while closed', () => {
    vi.useFakeTimers();
    try {
      const { input, focus } = setupSuggest();
      const status = () => screen.getByRole('status').textContent;
      expect(status()).toBe('');
      focus();
      act(() => {
        vi.advanceTimersByTime(399);
      });
      expect(status()).toBe('');
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(status()).toBe('3 suggestions');

      // A burst of typing is announced once, for where it ends.
      fireEvent.change(input, { target: { value: 's' } });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      fireEvent.change(input, { target: { value: 'st' } });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(status()).toBe('3 suggestions');

      fireEvent.keyDown(input, { key: 'Escape' });
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(status()).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('announces that there is nothing to suggest once the field is open with an empty list', () => {
    vi.useFakeTimers();
    try {
      const { focus } = setupSuggest([]);
      focus();
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(screen.getByRole('status').textContent).toBe('0 suggestions');
      expect(screen.queryByRole('listbox')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not open the list when focus is moved into the field by removing, editing or accepting, only when the person enters it', () => {
    const { input, focus } = setupSuggest();
    fireEvent.click(screen.getByRole('button', { name: 'Remove status:>=500' }));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(input);

    act(() => {
      input.blur();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit -status:404' }));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('false');

    act(() => {
      input.blur();
    });
    focus();
    expect(screen.getByRole('listbox')).toBeDefined();
  });

  it('opens the list again when the already-focused field is clicked', () => {
    const { input, focus } = setupSuggest();
    focus();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(input);
    expect(screen.getByRole('listbox')).toBeDefined();
  });

  it('keeps focus out of the list: it is not a tab stop', () => {
    const { focus } = setupSuggest();
    focus();
    expect(screen.getByRole('listbox').getAttribute('tabindex')).toBe('-1');
  });

  it('names the list after the field when no list label is given', () => {
    const onNothing = vi.fn();
    render(
      <ChipInput chips={[]} onSubmit={onNothing} onRemove={onNothing} labels={labels} suggestions={options} />,
    );
    act(() => {
      screen.getByRole('combobox').focus();
    });
    expect(screen.getByRole('listbox', { name: 'Search filters' })).toBeDefined();
  });

  it('marks the highlighted row with an outline as well as a fill, so it shows in forced-colours mode', () => {
    const { input, focus, rows } = setupSuggest();
    focus();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const row = rows()[0];
    expect(row?.className).toContain('aria-selected:outline-2');
    expect(row?.className).toContain('aria-selected:outline-ring');
    // Hover is a lighter tint only: it has no state, so it can never move the highlight.
    expect(row?.className).toContain('hover:bg-accent/50');
  });

  // A class pin, not a layout test: jsdom lays nothing out. The real thing (a 100-character API name that
  // widened the list to 643px in a 304px one, and squeezed a short label to 0px) was measured in headless
  // Chromium against the compiled CSS; see the batch notes.
  it('lets a long token break and the description wrap, stacking until the list (not the viewport) has room', () => {
    const long = `/${'segment/'.repeat(25)}`;
    const { focus, rows } = setupSuggest([{ id: 'long', label: long, description: 'a long explanation of it', apply: `path:${long}`, commit: true }]);
    focus();
    expect(screen.getByRole('listbox').className).toContain('@container');
    const row = rows()[0];
    expect(row?.className).toContain('flex-col');
    expect(row?.className).toContain('@sm:flex-row');
    expect(row?.className).not.toMatch(/(^|\s)sm:/);
    const [label, description] = Array.from(row?.children ?? []);
    for (const klass of ['min-w-0', 'break-all', '@sm:shrink-0', '@sm:max-w-[60%]']) expect(label?.className).toContain(klass);
    for (const klass of ['min-w-0', 'whitespace-normal', '[overflow-wrap:anywhere]']) expect(description?.className).toContain(klass);
  });

  it('gives the remove button its own focus ring and a bigger touch target, and hides the default outline in a forced-colours-safe way', () => {
    const { input } = setupSuggest();
    const remove = screen.getByRole('button', { name: 'Remove status:>=500' });
    expect(remove.className).toContain('focus-visible:outline-2');
    expect(remove.className).toContain('focus-visible:outline-current');
    expect(remove.className).toContain('pointer-coarse:size-6');
    expect(screen.getByRole('button', { name: 'Edit status:>=500' }).className).toContain('outline-hidden');
    expect(input.className).toContain('outline-hidden');
    expect(input.className).not.toContain('outline-none');
  });

  it('turns off auto-capitalisation and auto-correction, because the filters are lower-case words', () => {
    const { input } = setupSuggest();
    expect(input.getAttribute('autocapitalize')).toBe('off');
    expect(input.getAttribute('autocorrect')).toBe('off');
  });

  it('reports the text on every change, including a chip moved back into the field', () => {
    const { onDraftChange, input } = setupSuggest();
    fireEvent.change(input, { target: { value: 'a' } });
    expect(onDraftChange).toHaveBeenLastCalledWith('a');
    fireEvent.click(screen.getByRole('button', { name: 'Edit -status:404' }));
    expect(onDraftChange).toHaveBeenLastCalledWith('-status:404');
  });
});
