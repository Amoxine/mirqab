'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';

interface DashboardLayoutProps {
  children: React.ReactNode;
}

export default function DashboardLayout({ children }: DashboardLayoutProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const t = useTranslations('dashboard.layout');

  return (
    <div className="flex min-h-screen bg-background">
      {/* First tab stop: lets keyboard users jump past the sidebar's nine links on every page. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-[60] focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
      >
        {t('skipToContent')}
      </a>
      {/* Sidebar - visible on lg+; below that the header's MobileNav sheet takes over */}
      <div className="hidden lg:block">
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggle={() => {
            setSidebarCollapsed((prev) => !prev);
          }}
        />
      </div>

      {/* Main content */}
      <div
        className={`flex min-w-0 flex-1 flex-col transition-[padding-inline-start] duration-300 ease-out ${
          // ponytail: logical `ps-` so this stays clear of the sidebar's `start-0` edge in RTL too.
          sidebarCollapsed ? 'lg:ps-16' : 'lg:ps-64'
        }`}
      >
        <Header />
        <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-screen-2xl flex-1 p-4 outline-none md:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
