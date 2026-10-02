import { getTranslations } from 'next-intl/server';
import { AuthBrand } from '@/components/auth/auth-brand';

/** Centers each `/portal/auth/*` page's card, same visual language as the dashboard's own
 * `(auth)/layout.tsx` — including the logo above the card, which replaces the brand text the portal
 * header shows everywhere else (see `PortalHeader`). */
export default async function PortalAuthLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations('nav');
  const tPortal = await getTranslations('portal');
  return (
    <div className="flex flex-1 items-center justify-center py-8">
      <div className="w-full max-w-md space-y-6">
        {/* The header's "Developer Portal" text is dropped on these pages; keep it in the name. One
            message, so each language orders the two words its own way. */}
        <AuthBrand name={tPortal('authBrandName', { brand: t('brand') })} />
        {children}
      </div>
    </div>
  );
}
