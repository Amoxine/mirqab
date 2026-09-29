'use client';

import { useEffect, useRef, useState } from 'react';

/** Width of an element, kept current with a ResizeObserver; 0 until measured. */
export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);
  return [ref, width] as const;
}

/** True when the OS asks for reduced motion (SMIL packets and draw-in animations are skipped). */
export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = () => {
      setReduced(mq.matches);
    };
    mq.addEventListener('change', onChange);
    return () => {
      mq.removeEventListener('change', onChange);
    };
  }, []);
  return reduced;
}

/** A coordinate for SVG path strings (two decimals). */
export const fx = (v: number): string => v.toFixed(2);

/** Column with a 4px rounded data end and a square baseline. */
export function columnPath(x: number, y: number, w: number, base: number, radius = 4): string {
  const r = Math.max(0, Math.min(radius, w / 2, base - y));
  return `M${fx(x)},${fx(base)}V${fx(y + r)}Q${fx(x)},${fx(y)} ${fx(x + r)},${fx(y)}H${fx(x + w - r)}Q${fx(x + w)},${fx(y)} ${fx(x + w)},${fx(y + r)}V${fx(base)}Z`;
}

/** 0 / 1 / 2 / 2.5 / 5 × 10ⁿ ticks from zero to just above `max`. */
export function niceTicks(max: number, count = 3): { top: number; ticks: number[] } {
  if (max <= 0) return { top: 1, ticks: [0, 1] };
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const top = step * Math.ceil(max / step);
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  return { top, ticks };
}
