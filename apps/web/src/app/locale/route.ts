import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { LOCALES } from '@/i18n/locales';

/** Write side of the locale switcher (`components/layout/locale-switcher.tsx`). A preference, not a
 * secret — no httpOnly, so a page load can also read it client-side without a round trip. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  const locale = typeof body === 'object' && body !== null ? (body as { locale?: unknown }).locale : undefined;
  if (typeof locale !== 'string' || !(LOCALES as readonly string[]).includes(locale)) {
    return NextResponse.json({ success: false, error: 'invalid locale' }, { status: 400 });
  }
  (await cookies()).set('locale', locale, { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax' });
  return NextResponse.json({ success: true, data: { locale } });
}
