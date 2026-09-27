'use client';

import { useTheme } from 'next-themes';
import { Toaster as SonnerToaster } from 'sonner';

function Toaster() {
  // Follow the user's pick (theme switcher), not just the OS: a hard-coded "system" left toasts
  // light on a page the user had switched to dark.
  const { theme = 'system' } = useTheme();
  return (
    <SonnerToaster
      theme={theme === 'light' || theme === 'dark' ? theme : 'system'}
      position="top-right"
      toastOptions={{
        // Sonner's own stylesheet sets background/border/box-shadow on `[data-sonner-toast]
        // [data-styled=true]` (two attribute selectors), which beats a plain Tailwind class of
        // equal-or-lower specificity — the `classNames.toast` background/border/shadow classes
        // this used to carry never actually applied; the toast rendered Sonner's own hardcoded
        // dark palette (true black) instead of `--color-popover`. An inline `style` always wins,
        // on every toast regardless of type — which is also why this doesn't pair with Sonner's
        // `richColors` (its per-type tinted backgrounds would be inline-overridden right back to
        // neutral by this same rule). Type stays legible from the icon's shape, same as every
        // status icon elsewhere in the app that isn't itself a filled badge.
        // `classNames.description`/`.actionButton`/`.cancelButton` used to carry the same kind of
        // override and were just as dead: Sonner's [data-description]/[data-button]/[data-cancel]
        // rules set literal colours (or `--normal-bg`/`--normal-text`, which only the toast's own
        // theme controls), so a class on the sub-element never took effect either (checked via
        // computed style: description read Sonner's own #e8e8e8, the action button Sonner's own
        // near-white fill). Removed rather than left in place unverified.
        style: {
          background: 'var(--color-popover)',
          color: 'var(--color-popover-foreground)',
          border: '1px solid var(--color-border)',
          boxShadow: 'var(--shadow-lg)',
        },
      }}
    />
  );
}

export { Toaster };
export { toast } from 'sonner';
