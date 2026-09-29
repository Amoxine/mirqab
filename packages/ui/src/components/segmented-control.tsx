'use client';

import * as React from 'react';
import { ToggleGroup, ToggleGroupItem } from './toggle-group';

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  /** Longer text on hover (e.g. "Last 24 hours" for a "24h" chip). */
  title?: string;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  /** Accessible name of the group. */
  ariaLabel: string;
  className?: string;
}

/**
 * A row of mutually exclusive chips (a time range, a view mode) on the design's soft track.
 * Built on `ToggleGroup`, with the one behaviour a single-select group lacks for this use: the
 * active chip cannot be pressed off, so a value is always selected.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: SegmentedControlProps<T>) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      // Radix reports '' when the active item is pressed again.
      onValueChange={(next) => {
        if (next) onChange(next as T);
      }}
      aria-label={ariaLabel}
      className={className}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          title={option.title}
          className="px-3.5"
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
