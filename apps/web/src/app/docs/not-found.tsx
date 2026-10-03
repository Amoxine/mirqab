import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui/button';

/** An address under /docs that is no page. Rendered inside the docs layout, so the sidebar stays. */
export default async function DocsNotFound() {
  const t = await getTranslations('docs.notFound');
  return (
    <main className="mx-auto flex w-full max-w-xl flex-col items-start gap-3 px-4 py-16">
      <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
      <p className="text-muted-foreground">{t('description')}</p>
      <Button asChild>
        <Link href="/docs">{t('home')}</Link>
      </Button>
    </main>
  );
}
