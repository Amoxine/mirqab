'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FrameStrip } from '@/components/layout/frame-strip';
import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';

interface DashboardLayoutProps {
  children: React.ReactNode;
}

const SIDEBAR_KEY = 'mirqab-sidebar-collapsed';

export default function DashboardLayout({ children }: DashboardLayoutProps) {
  // The icon rail is the default; an expanded sidebar is remembered per browser.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const t = useTranslations('dashboard.layout');

  useEffect(() => {
    try {
      if (localStorage.getItem(SIDEBAR_KEY) === 'false') setSidebarCollapsed(false);
    } catch {
      // Storage blocked (private mode, policy): keep the default.
    }
  }, []);

  const toggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      try {
        localStorage.setItem(SIDEBAR_KEY, String(!prev));
      } catch {
        // Not persisted; the toggle still applies for this visit.
      }
      return !prev;
    });
  };

  return (
    // lg+: the app is one rounded panel inside a dark, grained frame; below lg it is edge to edge.
    <div className="min-h-screen bg-background lg:bg-frame lg:bg-grain lg:px-3 lg:pb-3">
      {/* First tab stop: lets keyboard users jump past the sidebar's links on every page. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-[60] focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
      >
        {t('skipToContent')}
      </a>
      <FrameStrip className="hidden lg:flex" />

      {/* `overflow-clip` (not hidden) rounds the panel without becoming a scroll container, so the
          sticky header and sidebar still stick to the viewport. */}
      <div className="relative flex min-h-screen bg-background lg:min-h-[calc(100dvh-3.5rem)] lg:overflow-clip lg:rounded-[1.625rem] lg:shadow-[0_0_0_1px_rgb(255_255_255/0.05)]">
        {/* Soft teal light from the top of the panel. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(80%_100%_at_50%_-20%,color-mix(in_srgb,var(--color-primary)_9%,transparent),transparent_70%)]"
        />
        {/* Sidebar — visible on lg+; below that the header's MobileNav sheet takes over. */}
        <div className="relative hidden lg:block">
          <Sidebar collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
        </div>

        <div className="relative flex min-w-0 flex-1 flex-col">
          <Header />
          <main
            id="main-content"
            tabIndex={-1}
            className="mx-auto w-full max-w-screen-2xl flex-1 px-4 pb-8 pt-2 outline-none md:px-6 lg:ps-2 lg:pe-7"
          >
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
