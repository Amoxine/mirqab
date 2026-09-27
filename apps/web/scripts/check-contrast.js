#!/usr/bin/env node
'use strict';

/**
 * WCAG 2.1 AA contrast check for every foreground/surface pair the UI actually renders, read straight
 * from the `--color-*` custom properties in globals.css — light from the `@theme` block, dark from
 * `.dark` (falling back to the light value for anything `.dark` doesn't override, same as the browser
 * cascade). A token used both as a fill (buttons, badges) and as text (links, form errors, status
 * text) is checked in both roles, because a shade dark enough for white text on it is often too dark
 * to read as text on a dark surface.
 *
 * Run: node scripts/check-contrast.js [path/to/globals.css]   (default: src/styles/globals.css)
 */
const fs = require('fs');
const path = require('path');

const CSS_PATH = process.argv[2] || path.join(__dirname, '..', 'src', 'styles', 'globals.css');
const MIN_RATIO = 4.5;

function readBlock(css, selector) {
  const match = css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
  return match ? match[1] : '';
}

function readVar(block, name) {
  const match = block.match(new RegExp(`--${name}:\\s*([^;]+);`));
  return match ? match[1].trim() : null;
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// WCAG relative luminance: https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
function channelLuminance(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance({ r, g, b }) {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

function contrastRatio(hexA, hexB) {
  const lA = relativeLuminance(hexToRgb(hexA));
  const lB = relativeLuminance(hexToRgb(hexB));
  const [lighter, darker] = lA > lB ? [lA, lB] : [lB, lA];
  return (lighter + 0.05) / (darker + 0.05);
}

const css = fs.readFileSync(CSS_PATH, 'utf8');
const theme = readBlock(css, '@theme');
const dark = readBlock(css, '\\.dark');

/**
 * [foreground token, background token, what it is]. `primary-10` is the active-nav / avatar tint:
 * `bg-primary/10` composited over the page background.
 */
const PAIRS = [
  ['primary-foreground', 'primary', 'primary button'],
  ['destructive-foreground', 'destructive', 'destructive button / badge'],
  ['success-foreground', 'success', 'success badge'],
  ['warning-foreground', 'warning', 'warning badge'],
  ['secondary-foreground', 'secondary', 'secondary button / badge'],
  ['foreground', 'background', 'body text'],
  ['card-foreground', 'card', 'card text'],
  ['popover-foreground', 'popover', 'menu text'],
  ['accent-foreground', 'accent', 'hovered menu item'],
  ['muted-foreground', 'background', 'secondary text on page'],
  ['muted-foreground', 'card', 'secondary text on card'],
  ['muted-foreground', 'muted', 'secondary text on muted surface'],
  ['muted-foreground', 'accent', 'secondary text on hovered item'],
  ['primary', 'background', 'link text on page'],
  ['primary', 'card', 'link text on card'],
  ['primary', 'primary-10', 'active nav item'],
  ['destructive', 'background', 'error text on page'],
  ['destructive', 'card', 'error text on card / form message'],
  ['success', 'card', 'success text on card'],
  ['warning', 'card', 'warning text on card'],
];

/**
 * Non-text contrast (WCAG 1.4.11, 3:1): the analytics chart series are these tokens drawn straight
 * onto the card, and a line or bar is only readable if it stands off that surface.
 */
const MIN_NON_TEXT = 3;
const NON_TEXT_PAIRS = [
  ['primary', 'card', 'requests / latency series'],
  ['success', 'card', '2xx bars'],
  ['warning', 'card', '4xx bars'],
  ['destructive', 'card', '5xx bars / error series'],
  // Field outlines and the off switch track. Dark only: the light theme keeps its hairline
  // #e2e8f0 (1.2:1), a known, accepted gap rather than an oversight.
  ['input', 'background', 'input outline on page', 'dark'],
  ['input', 'card', 'input outline on card', 'dark'],
];

/**
 * Surfaces drawn ON a card (skeletons, the tab list, table hover, secondary badges) must not be the
 * card colour itself, or they disappear. Not a WCAG ratio, only "visibly different".
 */
const MIN_SURFACE_STEP = 1.05;
const SURFACE_PAIRS = [
  ['muted', 'card', 'skeleton / tab list / table hover on a card'],
  ['secondary', 'card', 'secondary badge / button on a card'],
];

/** `alpha` of `fg` composited over `bg` — what `bg-primary/10` actually paints. */
function mix(fgHex, bgHex, alpha) {
  const f = hexToRgb(fgHex);
  const b = hexToRgb(bgHex);
  const c = (k) => Math.round(f[k] * alpha + b[k] * (1 - alpha));
  return `#${[c('r'), c('g'), c('b')].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function resolve(name, block) {
  if (name === 'primary-10') return mix(resolve('primary', block), resolve('background', block), 0.1);
  return (block && readVar(block, `color-${name}`)) || readVar(theme, `color-${name}`);
}

const CHECKS = [
  [PAIRS, MIN_RATIO],
  [NON_TEXT_PAIRS, MIN_NON_TEXT],
  [SURFACE_PAIRS, MIN_SURFACE_STEP],
];

let ok = true;
let count = 0;
for (const [themeName, block] of [['light', null], ['dark', dark]]) {
  for (const [pairs, min] of CHECKS) {
    for (const [fgName, bgName, label, onlyTheme] of pairs) {
      if (onlyTheme && onlyTheme !== themeName) continue;
      count += 1;
      const fg = resolve(fgName, block);
      const bg = resolve(bgName, block);
      if (!fg || !bg) {
        console.error(`[contrast] ${themeName}: could not read --color-${fgName} / --color-${bgName}`);
        ok = false;
        continue;
      }
      const ratio = contrastRatio(fg, bg);
      const pass = ratio >= min;
      ok = ok && pass;
      console.log(
        `[contrast] ${themeName}: ${fgName} ${fg} on ${bgName} ${bg} (${label}) = ${ratio.toFixed(2)}:1 ` +
          `(min ${min}) ${pass ? 'PASS' : 'FAIL'}`,
      );
    }
  }
}

if (!ok) {
  console.error('[contrast] FAILED — see the FAIL lines above for the pair and its minimum');
  process.exit(1);
}
console.log(`[contrast] all ${count} checks pass`);
