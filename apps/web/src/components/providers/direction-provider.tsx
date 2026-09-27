'use client';

// Radix primitives do not read `<html dir>`: without this, every menu, select and tab list rendered
// `dir="ltr"` inside the Arabic UI (items, check marks and `align="end"` all laid out left-to-right).
export { DirectionProvider } from '@radix-ui/react-direction';
