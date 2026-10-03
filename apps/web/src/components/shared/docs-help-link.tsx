'use client';

import Link from 'next/link';
import { BookOpen } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { docsHref, type DocsHelp } from '@/lib/docs/contextual';

/**
 * "Help" in a page header: opens the documentation page that explains the page, in the same tab (the
 * docs layout has the way back). The visible word is short so the actions row keeps wrapping; the
 * accessible name adds the topic, which comes from the translated messages, never from the slug.
 */
export function DocsHelpLink({ help }: { help: DocsHelp }) {
  const t = useTranslations('docs');
  return (
    <Button asChild variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
      <Link href={docsHref(help)} aria-label={t('help.aria', { topic: t(`help.topics.${help.slug}`) })}>
        <BookOpen className="h-4 w-4" aria-hidden="true" />
        {t('help.label')}
      </Link>
    </Button>
  );
}
