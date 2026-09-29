'use client';

import * as React from 'react';
import { Filter, FilterX } from 'lucide-react';
import { cn } from '../lib/utils';
import { Badge } from './badge';
import { Button } from './button';
import { Card } from './card';
import { Input } from './input';
import { Label } from './label';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './select';
import { SegmentedControl } from './segmented-control';

/*
 * PageFilter — one dynamic filter bar for every page that filters a list, table or chart.
 *
 * It is presentational and controlled: the page owns the values (URL params, useState, a form…),
 * describes the controls as data (`fields`), and receives changes as a patch. Nothing here knows
 * about i18n, routing or data fetching — labels arrive as props and option lists are plain arrays
 * (a dependent option list, like "keys of the chosen API", is just the caller passing different
 * `options` once the other value changes).
 */

/** A filter value: absent, a string (select / search / date / segmented) or a number. */
export type FilterValue = string | number | undefined;
export type FilterValues = Record<string, FilterValue>;

interface FieldBase {
  /** Key in `values` and in the patch handed to `onChange`. */
  key: string;
  /** Visible caption in the card / popover layouts, accessible name everywhere. */
  label: string;
  className?: string;
  /**
   * Whether an active value counts towards the "N filters" tally and enables Reset. Default true,
   * except for `segmented` fields (a time range always applies, so it narrows nothing).
   */
  countAsFilter?: boolean;
}

export interface SelectFilterField extends FieldBase {
  type: 'select';
  options: { value: string; label: string }[];
  /** Text of the "no filter" entry. Selecting it emits `undefined`; the sentinel never leaves the component. */
  allLabel: string;
  /** `'number'` emits `Number(value)` (e.g. "slower than 500 ms"). Default `'string'`. */
  valueType?: 'string' | 'number';
  disabled?: boolean;
}

export interface SearchFilterField extends FieldBase {
  type: 'search';
  placeholder?: string;
  maxLength?: number;
  /** `ltr` for paths, ids and other left-to-right data in an RTL page. */
  dir?: 'ltr' | 'rtl' | 'auto';
  /** Pause after the last keystroke before `onChange` fires. Default 350; 0 fires on every keystroke. */
  debounceMs?: number;
}

export interface NumberFilterField extends FieldBase {
  type: 'number';
  placeholder?: string;
  /** Digits only; a draft outside `min`..`max` (or empty) emits `undefined`. */
  min?: number;
  max?: number;
  /** Longest input accepted. Default: the digit count of `max`, else 9. */
  maxDigits?: number;
  debounceMs?: number;
}

export interface DateFilterField extends FieldBase {
  type: 'date';
}

export interface SegmentedFilterField extends FieldBase {
  type: 'segmented';
  options: { value: string; label: React.ReactNode; title?: string }[];
}

export type FilterField =
  | SelectFilterField
  | SearchFilterField
  | NumberFilterField
  | DateFilterField
  | SegmentedFilterField;

export interface PageFilterLabels {
  /** Name of the whole control: the search landmark in `card`, the trigger text in `popover`. */
  title: string;
  reset: string;
  /** "3 filters active" — pluralisation belongs to the caller's i18n. */
  active: (count: number) => string;
}

export interface PageFilterProps {
  fields: FilterField[];
  values: FilterValues;
  /** Receives only what changed; a cleared field arrives as `key: undefined`. */
  onChange: (patch: FilterValues) => void;
  onReset: () => void;
  labels: PageFilterLabels;
  /**
   * `card` — a bordered card: segmented fields in a toolbar row, the rest in a labelled grid.
   * `inline` — one wrapping row of compact controls (Reset appears only while something is active).
   * `popover` — a "Filters" button with an active-count badge; the fields open in a panel.
   */
  layout?: 'card' | 'inline' | 'popover';
  /**
   * Whether the `inline` layout shows its own Reset button while something is active. Turn it off
   * where the page already offers a clear action (e.g. in the empty state). Default true.
   */
  showReset?: boolean;
  className?: string;
}

/** Radix Select forbids an empty item value, so "no filter" is this internal sentinel. */
const ALL = '__all__';
const DEFAULT_DEBOUNCE_MS = 350;
const LABEL_CLASS =
  'text-muted-foreground font-mono text-[0.66rem] font-normal uppercase tracking-[0.08em]';

const isEmpty = (value: FilterValue): boolean => value === undefined || value === '';

/** How many filters currently narrow the view. */
export function countActiveFilters(fields: FilterField[], values: FilterValues): number {
  return fields.filter(
    (field) => (field.countAsFilter ?? field.type !== 'segmented') && !isEmpty(values[field.key]),
  ).length;
}

/**
 * A text draft that commits to the parent after a pause, and re-syncs when the parent's value
 * changes underneath it (browser back, Reset). Committing on every keystroke would refetch per key.
 * A delay of 0 commits on every keystroke instead — right when filtering happens client-side.
 */
/** Set by Reset for one render so the controls it remounts drop their draft instead of flushing it. */
const discardDrafts = { current: false };

function useDebouncedDraft(value: string, commit: (draft: string) => void, delayMs: number) {
  const [draft, setDraft] = React.useState(value);
  const commitRef = React.useRef(commit);
  commitRef.current = commit;
  const pendingRef = React.useRef({ draft: value, value });
  pendingRef.current = { draft, value };

  React.useEffect(() => {
    setDraft(value);
  }, [value]);

  React.useEffect(() => {
    if (delayMs <= 0 || draft === value) return;
    const id = window.setTimeout(() => {
      commitRef.current(draft);
    }, delayMs);
    return () => {
      window.clearTimeout(id);
    };
  }, [draft, value, delayMs]);

  // Closing a popover unmounts the control: flush what was typed instead of dropping it.
  React.useEffect(
    () => () => {
      const { draft: last, value: current } = pendingRef.current;
      if (!discardDrafts.current && delayMs > 0 && last !== current) commitRef.current(last);
    },
    [delayMs],
  );

  const update = (next: string) => {
    setDraft(next);
    if (delayMs <= 0) commitRef.current(next);
  };

  return [draft, update] as const;
}

interface ControlProps<F extends FilterField> {
  field: F;
  id: string;
  value: FilterValue;
  onChange: (patch: FilterValues) => void;
  /** Where the trigger stretches: full width inside a grid/popover, a fixed width in a row. */
  compact: boolean;
}

function SelectControl({ field, id, value, onChange, compact }: ControlProps<SelectFilterField>) {
  return (
    <Select
      value={isEmpty(value) ? ALL : String(value)}
      disabled={field.disabled}
      onValueChange={(next) => {
        onChange({
          [field.key]:
            next === ALL ? undefined : field.valueType === 'number' ? Number(next) : next,
        });
      }}
    >
      <SelectTrigger
        id={id}
        aria-label={field.label}
        className={cn('h-9 w-full', compact && 'sm:w-[11.5rem]', field.className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value={ALL}>{field.allLabel}</SelectItem>
          {field.options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function SearchControl({ field, id, value, onChange }: ControlProps<SearchFilterField>) {
  const [draft, setDraft] = useDebouncedDraft(
    typeof value === 'string' ? value : '',
    (next) => {
      onChange({ [field.key]: next.trim() === '' ? undefined : next });
    },
    field.debounceMs ?? DEFAULT_DEBOUNCE_MS,
  );
  return (
    <Input
      id={id}
      type="search"
      aria-label={field.label}
      className={cn('h-9', field.className)}
      dir={field.dir}
      maxLength={field.maxLength}
      placeholder={field.placeholder}
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
      }}
    />
  );
}

function NumberControl({ field, id, value, onChange }: ControlProps<NumberFilterField>) {
  const maxDigits = field.maxDigits ?? (field.max === undefined ? 9 : String(field.max).length);
  const [draft, setDraft] = useDebouncedDraft(
    value === undefined ? '' : String(value),
    (next) => {
      const parsed = Number(next);
      const valid =
        next.trim() !== '' &&
        Number.isInteger(parsed) &&
        (field.min === undefined || parsed >= field.min) &&
        (field.max === undefined || parsed <= field.max);
      onChange({ [field.key]: valid ? parsed : undefined });
    },
    field.debounceMs ?? DEFAULT_DEBOUNCE_MS,
  );
  return (
    <Input
      id={id}
      inputMode="numeric"
      aria-label={field.label}
      className={cn('h-9', field.className)}
      dir="ltr"
      placeholder={field.placeholder}
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value.replace(/\D/g, '').slice(0, maxDigits));
      }}
    />
  );
}

function DateControl({ field, id, value, onChange }: ControlProps<DateFilterField>) {
  return (
    <Input
      id={id}
      type="date"
      aria-label={field.label}
      className={cn('h-9', field.className)}
      value={typeof value === 'string' ? value : ''}
      onChange={(event) => {
        onChange({ [field.key]: event.target.value === '' ? undefined : event.target.value });
      }}
    />
  );
}

function SegmentedFieldControl({ field, value, onChange }: ControlProps<SegmentedFilterField>) {
  return (
    <SegmentedControl
      ariaLabel={field.label}
      className={field.className}
      value={typeof value === 'string' ? value : ''}
      options={field.options}
      onChange={(next) => {
        onChange({ [field.key]: next });
      }}
    />
  );
}

function FieldControl(props: ControlProps<FilterField>) {
  const { field } = props;
  switch (field.type) {
    case 'select':
      return <SelectControl {...props} field={field} />;
    case 'search':
      return <SearchControl {...props} field={field} />;
    case 'number':
      return <NumberControl {...props} field={field} />;
    case 'date':
      return <DateControl {...props} field={field} />;
    case 'segmented':
      return <SegmentedFieldControl {...props} field={field} />;
  }
}

/**
 * Renders every field in the given layout. Segmented fields are the "toolbar" of the card layout
 * (a time range belongs next to Reset, not in the grid).
 */
export function PageFilter({
  fields,
  values,
  onChange,
  onReset,
  labels,
  layout = 'card',
  showReset = true,
  className,
}: PageFilterProps) {
  const baseId = React.useId();
  // Bumped by Reset so controls holding an uncommitted draft remount empty.
  const [resetCount, setResetCount] = React.useState(0);
  React.useEffect(() => {
    discardDrafts.current = false;
  }, [resetCount]);
  const active = countActiveFilters(fields, values);
  const idOf = (field: FilterField) => `${baseId}-${field.key}`;

  const resetButton = (
    <Button type="button" variant="outline" size="sm" disabled={active === 0} onClick={() => {
        discardDrafts.current = true;
        setResetCount((n) => n + 1);
        onReset();
      }}
    >
      <FilterX aria-hidden="true" />
      {labels.reset}
    </Button>
  );
  const activeText = active > 0 && (
    <span className="text-muted-foreground text-xs" role="status">
      {labels.active(active)}
    </span>
  );

  const control = (field: FilterField, compact: boolean) => (
    <FieldControl
      key={resetCount}
      field={field}
      id={idOf(field)}
      value={values[field.key]}
      onChange={onChange}
      compact={compact}
    />
  );

  // A visible, real <label> above each control (card and popover).
  const labelled = (field: FilterField) => (
    <div key={field.key} className="min-w-0 space-y-1">
      {field.type === 'segmented' ? (
        <span className={LABEL_CLASS}>{field.label}</span>
      ) : (
        <Label htmlFor={idOf(field)} className={LABEL_CLASS}>
          {field.label}
        </Label>
      )}
      {control(field, false)}
    </div>
  );

  const segmented = fields.filter((field) => field.type === 'segmented');
  const rest = fields.filter((field) => field.type !== 'segmented');

  if (layout === 'inline') {
    return (
      <div
        role="search"
        aria-label={labels.title}
        className={cn('flex flex-wrap items-center gap-2', className)}
      >
        {segmented.map((field) => (
          <React.Fragment key={field.key}>{control(field, true)}</React.Fragment>
        ))}
        {rest.map((field) => (
          <React.Fragment key={field.key}>{control(field, true)}</React.Fragment>
        ))}
        {showReset && active > 0 && resetButton}
      </div>
    );
  }

  if (layout === 'popover') {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" className={className}>
            <Filter aria-hidden="true" />
            {labels.title}
            {active > 0 && <Badge variant="secondary">{active}</Badge>}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-80 max-w-[calc(100vw-2rem)] space-y-3"
          aria-label={labels.title}
        >
          {fields.map(labelled)}
          <div className="flex justify-end">{resetButton}</div>
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <Card role="search" aria-label={labels.title} className={cn('space-y-3 p-3.5', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {segmented.map((field) => (
            <React.Fragment key={field.key}>{control(field, false)}</React.Fragment>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {activeText}
          {resetButton}
        </div>
      </div>
      {rest.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{rest.map(labelled)}</div>
      )}
    </Card>
  );
}
