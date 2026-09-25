import { PortalHeader } from '@/components/portal/portal-header';

/**
 * The portal's own shell (WP23) — a separate identity domain from the dashboard's `(dashboard)`
 * route group, deliberately not nested under it and not importing anything from it (enforced by
 * the `no-restricted-imports` block in eslint.config.js scoped to this directory). Chrome only:
 * whether a given page needs a live developer session is that page's own concern, the same split
 * `(dashboard)/layout.tsx` and its pages already use for RBAC.
 */
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <PortalHeader />
      <main id="main-content" className="mx-auto w-full max-w-6xl flex-1 p-4 md:p-6">
        {children}
      </main>
    </div>
  );
}
