/** Centers each `/portal/auth/*` page's card, same visual language as the dashboard's own
 * `(auth)/layout.tsx` — the brand header above it comes from `portal/layout.tsx`, not duplicated here. */
export default function PortalAuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center py-8">
      <div className="w-full max-w-md space-y-8">{children}</div>
    </div>
  );
}
