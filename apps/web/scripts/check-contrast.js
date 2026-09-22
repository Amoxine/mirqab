#!/usr/bin/env node
'use strict';

/**
 * WCAG 2.1 AA contrast check for the primary/primary-foreground color pair, read straight from the
 * `--color-*` custom properties in globals.css — light from the `@theme` block, dark from `.dark`
 * (falling back to the light value for anything `.dark` doesn't override, same as the browser cascade).
 * Run: node scripts/check-contrast.js
 */
const fs = require('fs');
const path = require('path');

const CSS_PATH = path.join(__dirname, '..', 'src', 'styles', 'globals.css');
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

const themes = [
  {
    name: 'light',
    bg: readVar(theme, 'color-primary'),
    fg: readVar(theme, 'color-primary-foreground'),
  },
  {
    name: 'dark',
    bg: readVar(dark, 'color-primary') || readVar(theme, 'color-primary'),
    fg: readVar(dark, 'color-primary-foreground') || readVar(theme, 'color-primary-foreground'),
  },
];

let ok = true;
for (const { name, bg, fg } of themes) {
  if (!bg || !fg) {
    console.error(`[contrast] could not read --color-primary/--color-primary-foreground for the ${name} theme`);
    ok = false;
    continue;
  }
  const ratio = contrastRatio(bg, fg);
  const pass = ratio >= MIN_RATIO;
  ok = ok && pass;
  console.log(
    `[contrast] ${name}: primary ${bg} vs primary-foreground ${fg} = ${ratio.toFixed(2)}:1 ` +
      `${pass ? 'PASS' : 'FAIL'} (needs ${MIN_RATIO}:1)`,
  );
}

if (!ok) {
  console.error('[contrast] FAILED — see above');
  process.exit(1);
}
console.log('[contrast] all pairs pass WCAG AA (4.5:1)');
