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
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
          description: 'group-[.toast]:text-muted-foreground',
          actionButton:
            'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
          cancelButton:
            'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
        },
      }}
    />
  );
}

export { Toaster };
export { toast } from 'sonner';
