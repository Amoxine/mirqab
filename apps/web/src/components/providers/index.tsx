import type { ReactNode } from 'react';
import { DirectionProvider } from '@/components/providers/direction-provider';
import { ThemeProvider } from '@/components/providers/theme-provider';
import { QueryProvider } from '@/components/providers/query-provider';
import { Toaster } from '@/components/ui/sonner';

interface ProvidersProps {
  children: ReactNode;
  dir: 'ltr' | 'rtl';
}

export function Providers({ children, dir }: ProvidersProps) {
  return (
    <DirectionProvider dir={dir}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <QueryProvider>{children}</QueryProvider>
        <Toaster />
      </ThemeProvider>
    </DirectionProvider>
  );
}
