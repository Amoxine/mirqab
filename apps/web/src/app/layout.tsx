import type { Metadata } from 'next';
import { IBM_Plex_Mono, Inter } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale } from 'next-intl/server';
import { Providers } from '@/components/providers';
import { APP_URL } from '@/lib/hydra-admin';
import { RTL_LOCALES } from '@/i18n/locales';
import '@/styles/globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

// The utility face for identifiers, units and timestamps — read through `--font-mono` in globals.css.
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'MIRQAB - Admin Dashboard',
    template: '%s | MIRQAB',
  },
  description: 'Production-ready SaaS admin dashboard',
  keywords: ['admin', 'dashboard', 'saas', 'management'],
  authors: [{ name: 'MIRQAB Team' }],
  creator: 'MIRQAB',
  publisher: 'MIRQAB',
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
  metadataBase: new URL(APP_URL),
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: APP_URL,
    title: 'MIRQAB - Admin Dashboard',
    description: 'Production-ready SaaS admin dashboard',
    siteName: 'MIRQAB',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'MIRQAB - Admin Dashboard',
    description: 'Production-ready SaaS admin dashboard',
  },
  robots: {
    index: false,
    follow: false,
    googleBot: {
      index: false,
      follow: false,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  // No `icons` block: none of those files exist, so declaring them only produced 404s.
  // `src/app/icon.svg` is picked up by Next's file convention and emits the <link> itself.
};

interface RootLayoutProps {
  children: React.ReactNode;
}

export default async function RootLayout({ children }: RootLayoutProps) {
  const locale = await getLocale();
  const dir = (RTL_LOCALES as readonly string[]).includes(locale) ? 'rtl' : 'ltr';

  return (
    <html lang={locale} dir={dir} suppressHydrationWarning>
      <body className={`${inter.variable} ${plexMono.variable} font-sans antialiased`}>
        <NextIntlClientProvider>
          <Providers dir={dir}>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
