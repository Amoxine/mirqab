import { getTranslations } from 'next-intl/server';
import { AuthBrand } from '@/components/auth/auth-brand';
import { LocaleSwitcher } from '@/components/layout/locale-switcher';
import { ThemeSwitcher } from '@/components/layout/theme-switcher';

// Shared by every /auth/* page (login/register/settings/recovery/verification) — each renders its
// own CardTitle/CardDescription, since "Sign in to your account" no longer fits all five.
export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = await getTranslations('nav');
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-background to-primary/10 p-4">
      {/* Reachable before login too — otherwise an Arabic/French-speaking visitor has no way to
       * change language until AFTER completing an all-English sign-in. */}
      <div className="absolute end-4 top-4 flex items-center gap-2">
        <ThemeSwitcher />
        <LocaleSwitcher />
      </div>
      <div className="w-full max-w-md space-y-6">
        <AuthBrand name={t('brand')} />
        {children}
      </div>
    </main>
  );
}
