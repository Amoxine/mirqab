'use client';

import { useState } from 'react';
import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';

interface DashboardLayoutProps {
  children: React.ReactNode;
}

export default function DashboardLayout({ children }: DashboardLayoutProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  return (
    <div className="flex min-h-screen bg-background">
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
        className={`flex min-w-0 flex-1 flex-col transition-all duration-300 ${
          // ponytail: logical `ps-` so this stays clear of the sidebar's `start-0` edge in RTL too.
          sidebarCollapsed ? 'lg:ps-16' : 'lg:ps-64'
        }`}
      >
        <Header />
        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
