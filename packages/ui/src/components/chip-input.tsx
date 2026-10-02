'use client';

import * as React from 'react';
import { X } from 'lucide-react';
import { cn } from '../lib/utils';
import { Badge } from './badge';

export interface ChipInputChip {
  id: string;
  /** What the chip shows, and what editing it puts back into the input. */
  text: string;
  /** `negated` for an exclusion, `error` for a token that could not be understood. */
  tone?: 'default' | 'negated' | 'error';
}

export interface ChipInputLabels {
  /** Accessible name of the text field. */
  input: string;
  placeholder: string;
  /** Accessible name of a chip's remove button. */
  remove: (text: string) => string;
  /** Accessible name of a chip (clicking it edits). */
  edit: (text: string) => string;
  /** Accessible name of the suggestion list; the field's own label when left out. */
  suggestions?: string;
  /** Polite announcement of how many suggestions are showing. */
  suggestionCount?: (count: number) => string;
}

export interface ChipInputSuggestion {
  /** Unique within one list. */
  id: string;
  /** What the row shows: a token of the parent's language, so it stays left-to-right. */
  label: string;
  /** One line of explanation, in the page's language and direction. */
  description?: string;
  /** The field's FULL text once this is accepted: the parent decides what completing means. */
  apply: string;
  /** Accepting submits `apply` as a chip (and clears the field) instead of putting it in the field. */
  commit?: boolean;
  /** The part of `label` to emphasise: what matched the text typed. */
  match?: { start: number; end: number };
}

export interface ChipInputProps {
  chips: ChipInputChip[];
  /** The text typed when Enter was pressed; the parent turns it into chips. Never called when blank. */
  onSubmit: (text: string) => void;
  onRemove: (id: string) => void;
  labels: ChipInputLabels;
  /** Id of an element that explains the chips (error messages), so a screen reader hears them. */
  describedBy?: string;
  className?: string;
  /** Called with the field's text whenever it changes, so the parent can work out `suggestions` for it. */
  onDraftChange?: (draft: string) => void;
  /** What to offer for the current text. Passing it, even empty, makes the field a combobox. */
  suggestions?: ChipInputSuggestion[];
}

const TONE: Record<NonNullable<ChipInputChip['tone']>, 'outline' | 'warning' | 'destructive'> = {
  default: 'outline',
  negated: 'warning',
  error: 'destructive',
};

const optionId = (listId: string, index: number) => `${listId}-${String(index)}`;

/** A screen reader hears the count once typing pauses, not once per key. */
const ANNOUNCE_DELAY_MS = 400;

/** `text` with the `match` range in bold, so the eye finds what the typed text corresponds to. */
function Emphasised({ text, match }: { text: string; match: ChipInputSuggestion['match'] }) {
  if (!match || match.end <= match.start) return text;
  return (
    <>
      {text.slice(0, match.start)}
      <span className="font-bold">{text.slice(match.start, match.end)}</span>
      {text.slice(match.end)}
    </>
  );
}

/**
 * A text field that turns what is typed into removable chips: Enter commits, Backspace on an empty
 * field removes the last chip, and activating a chip moves its text back into the field to edit.
 * It does not know what the text means: the parent parses it and reports back through `chips`.
 *
 * Given `suggestions` it is also an ARIA combobox: the list opens on focus and on typing; the arrows
 * highlight a row, Tab and Enter accept it (with no row highlighted they leave the field and submit, as
 * ever), Escape closes. The parent owns what the rows are.
 */
export function ChipInput({
  chips,
  onSubmit,
  onRemove,
  labels,
  describedBy,
  className,
  onDraftChange,
  suggestions,
}: ChipInputProps) {
  const [draft, setDraft] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [composing, setComposing] = React.useState(false);
  // The highlighted row's id, not its index: a list that changes under it simply loses the highlight.
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const movingFocus = React.useRef(false);
  const listId = React.useId();

  const combobox = suggestions !== undefined;
  const list = suggestions ?? [];
  const expanded = combobox && open && !composing && list.length > 0;
  const activeIndex = expanded ? list.findIndex((suggestion) => suggestion.id === activeId) : -1;
  // What a screen reader is told: the count while the person is working in the field, even when it is zero.
  const announcement = combobox && open && !composing && labels.suggestionCount ? labels.suggestionCount(list.length) : '';
  const [announced, setAnnounced] = React.useState('');

  React.useEffect(() => {
    const timer = window.setTimeout(
      () => {
        setAnnounced(announcement);
      },
      announcement === '' ? 0 : ANNOUNCE_DELAY_MS,
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [announcement]);

  React.useEffect(() => {
    const row = activeIndex < 0 ? null : document.getElementById(optionId(listId, activeIndex));
    // jsdom has no scrollIntoView; a browser always does.
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, listId]);

  const changeDraft = (next: string) => {
    setDraft(next);
    onDraftChange?.(next);
  };

  /** Puts the caret back in the field after a click elsewhere. That is not the person entering it, so it does not open the list. */
  const returnFocus = () => {
    setOpen(false);
    movingFocus.current = true;
    inputRef.current?.focus();
    movingFocus.current = false;
  };

  const edit = (chip: ChipInputChip) => {
    changeDraft(chip.text);
    onRemove(chip.id);
    returnFocus();
  };

  const accept = (suggestion: ChipInputSuggestion) => {
    setActiveId(null);
    if (suggestion.commit) {
      if (suggestion.apply.trim() !== '') onSubmit(suggestion.apply);
      changeDraft('');
      returnFocus();
    } else {
      changeDraft(suggestion.apply);
      returnFocus();
      // Accepting a field name goes straight on to its values.
      setOpen(true);
    }
  };

  const move = (step: 1 | -1) => {
    const next = activeIndex < 0 ? (step === 1 ? 0 : list.length - 1) : (activeIndex + step + list.length) % list.length;
    setActiveId(list[next]?.id ?? null);
  };

  /** True when the key was a suggestion key and has been dealt with. */
  const handleSuggestionKey = (event: React.KeyboardEvent<HTMLInputElement>): boolean => {
    const highlighted = list[activeIndex];
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        if (list.length === 0) return false;
        event.preventDefault();
        setOpen(true);
        move(event.key === 'ArrowDown' ? 1 : -1);
        return true;
      case 'Tab':
        // Only a row that was chosen with the arrows: otherwise Tab must leave the field, rows showing or not.
        if (!highlighted || event.shiftKey) return false;
        event.preventDefault();
        accept(highlighted);
        return true;
      case 'Enter':
        if (!highlighted) return false;
        event.preventDefault();
        accept(highlighted);
        return true;
      case 'Escape':
        if (!expanded) return false;
        event.preventDefault();
        setOpen(false);
        setActiveId(null);
        return true;
      default:
        return false;
    }
  };

  return (
    <div
      className={cn(
        'border-input bg-background focus-within:ring-ring relative flex min-h-10 flex-wrap items-center gap-1.5 rounded-md border px-2 py-1.5 focus-within:ring-2',
        className,
      )}
    >
      {chips.map((chip) => (
        <Badge
          key={chip.id}
          variant={TONE[chip.tone ?? 'default']}
          className="gap-1 pe-1 font-mono text-[0.72rem] font-medium"
        >
          <button
            type="button"
            dir="ltr"
            aria-label={labels.edit(chip.text)}
            className="rounded-sm outline-hidden focus-visible:ring-2"
            onClick={() => {
              edit(chip);
            }}
          >
            {chip.text}
          </button>
          <button
            type="button"
            aria-label={labels.remove(chip.text)}
            // Its own ring, in the chip's text colour: a ring on the field would not show against a filled error or negated chip.
            className="hover:bg-foreground/10 pointer-coarse:size-6 grid size-4 place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-current"
            onClick={() => {
              onRemove(chip.id);
              returnFocus();
            }}
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        </Badge>
      ))}
      <input
        ref={inputRef}
        type="text"
        dir="ltr"
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        value={draft}
        aria-label={labels.input}
        aria-describedby={describedBy}
        role={combobox ? 'combobox' : undefined}
        aria-autocomplete={combobox ? 'list' : undefined}
        aria-expanded={combobox ? expanded : undefined}
        aria-controls={expanded ? listId : undefined}
        aria-activedescendant={activeIndex < 0 ? undefined : optionId(listId, activeIndex)}
        placeholder={chips.length === 0 ? labels.placeholder : ''}
        className="placeholder:text-muted-foreground min-w-40 flex-1 bg-transparent px-1 py-0.5 font-mono text-sm outline-hidden"
        onChange={(event) => {
          changeDraft(event.target.value);
          setActiveId(null);
          setOpen(true);
        }}
        onFocus={() => {
          if (!movingFocus.current) setOpen(true);
        }}
        onClick={() => {
          setOpen(true);
        }}
        onBlur={() => {
          setOpen(false);
          setActiveId(null);
        }}
        onCompositionStart={() => {
          setComposing(true);
        }}
        onCompositionEnd={() => {
          setComposing(false);
        }}
        onKeyDown={(event) => {
          if (combobox && !event.nativeEvent.isComposing && handleSuggestionKey(event)) return;
          // Enter that confirms an IME composition must not also submit.
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (draft.trim() === '') return;
            onSubmit(draft);
            changeDraft('');
            setOpen(false);
          } else if (event.key === 'Backspace' && draft === '') {
            const last = chips[chips.length - 1];
            if (last) onRemove(last.id);
          }
        }}
      />
      {combobox && labels.suggestionCount && (
        <span role="status" className="sr-only">
          {announced}
        </span>
      )}
      {expanded && (
        <ul
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-label={labels.suggestions ?? labels.input}
          // Keeps focus in the field when a row (or the list's scrollbar) is pressed; the click still lands.
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          className="bg-popover text-popover-foreground @container absolute start-0 top-full z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-md border p-1 shadow-md"
        >
          {list.map((suggestion, index) => (
            <li
              key={suggestion.id}
              id={optionId(listId, index)}
              role="option"
              aria-selected={index === activeIndex}
              // The highlighted row has an outline as well as a fill: the fill alone is too faint, and gone in forced-colours mode.
              // Stacked until the LIST (a container query, not the viewport) has room for a token and its description side by side.
              className="hover:bg-accent/50 aria-selected:bg-accent aria-selected:text-accent-foreground aria-selected:outline-ring flex cursor-pointer flex-col gap-0.5 rounded-sm px-2 py-1.5 text-sm aria-selected:outline aria-selected:outline-2 aria-selected:-outline-offset-2 @sm:flex-row @sm:items-baseline @sm:gap-3"
              onClick={() => {
                accept(suggestion);
              }}
            >
              <span dir="ltr" className="min-w-0 break-all font-mono @sm:max-w-[60%] @sm:shrink-0">
                <Emphasised text={suggestion.label} match={suggestion.match} />
              </span>
              {suggestion.description && (
                <span className="text-muted-foreground min-w-0 whitespace-normal text-xs [overflow-wrap:anywhere] @sm:ms-auto @sm:text-end">{suggestion.description}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
