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
}

const TONE: Record<NonNullable<ChipInputChip['tone']>, 'outline' | 'warning' | 'destructive'> = {
  default: 'outline',
  negated: 'warning',
  error: 'destructive',
};

/**
 * A text field that turns what is typed into removable chips: Enter commits, Backspace on an empty
 * field removes the last chip, and activating a chip moves its text back into the field to edit.
 * It does not know what the text means: the parent parses it and reports back through `chips`.
 */
export function ChipInput({ chips, onSubmit, onRemove, labels, describedBy, className }: ChipInputProps) {
  const [draft, setDraft] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);

  const edit = (chip: ChipInputChip) => {
    setDraft(chip.text);
    onRemove(chip.id);
    inputRef.current?.focus();
  };

  return (
    <div
      className={cn(
        'border-input bg-background focus-within:ring-ring flex min-h-10 flex-wrap items-center gap-1.5 rounded-md border px-2 py-1.5 focus-within:ring-2',
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
            className="rounded-sm focus-visible:outline-none focus-visible:ring-2"
            onClick={() => {
              edit(chip);
            }}
          >
            {chip.text}
          </button>
          <button
            type="button"
            aria-label={labels.remove(chip.text)}
            className="hover:bg-foreground/10 grid size-4 place-items-center rounded-full"
            onClick={() => {
              onRemove(chip.id);
              inputRef.current?.focus();
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
        value={draft}
        aria-label={labels.input}
        aria-describedby={describedBy}
        placeholder={chips.length === 0 ? labels.placeholder : ''}
        className="placeholder:text-muted-foreground min-w-40 flex-1 bg-transparent px-1 py-0.5 font-mono text-sm outline-none"
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onKeyDown={(event) => {
          // Enter that confirms an IME composition must not also submit.
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (draft.trim() === '') return;
            onSubmit(draft);
            setDraft('');
          } else if (event.key === 'Backspace' && draft === '') {
            const last = chips[chips.length - 1];
            if (last) onRemove(last.id);
          }
        }}
      />
    </div>
  );
}
