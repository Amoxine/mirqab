'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** Hydra's `urls.error` target — reached on an OAuth2-level failure (e.g. `invalid_client`), not a
 * login/consent rejection (those redirect straight back to the client instead). */
export default function OAuth2ErrorPage() {
  return (
    <Suspense>
      <OAuth2ErrorPageContent />
    </Suspense>
  );
}

function OAuth2ErrorPageContent() {
  const t = useTranslations('auth');
  const params = useSearchParams();
  const error = params.get('error') ?? params.get('error_hint') ?? t('oauth2Error.unknownError');
  const description = params.get('error_description');

  return (
    // This route sits outside the `(auth)` group (Hydra dictates its exact path), so it has no
    // shared layout to center it — inline the same wrapper `(auth)/layout.tsx` uses.
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-background to-primary-light/20 p-4">
      <Card className="w-full max-w-md border-border/50 shadow-lg">
        <CardHeader className="text-center">
          <AlertTriangle className="mx-auto h-10 w-10 text-destructive" aria-hidden="true" />
          <CardTitle className="text-2xl font-bold">{t('oauth2Error.title')}</CardTitle>
          <CardDescription>{description ?? error}</CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Button asChild>
            <Link href="/oauth2/authorize">{t('oauth2Error.tryAgain')}</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
