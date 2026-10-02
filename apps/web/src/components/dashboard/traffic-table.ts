/** What the dashboard's two traffic tables (per API, per endpoint) share. */

/** Error rate at or above this share of requests is flagged in the table (text + colour). */
export const ERROR_FLAG = 5;

/**
 * The text colour of a flagged error rate on the ink card. The destructive token there (#f87171) is 5.2:1 on
 * the light theme's ink but 3.6:1 on the dark theme's, and less under a hovered row, so a lighter red is
 * used: `traffic-tables.contrast.test.tsx` holds it to 4.5:1 against both inks, with the card's corner
 * gradient and a hovered row's fill on top.
 */
export const FLAGGED_RATE = 'text-[#fecaca]';
