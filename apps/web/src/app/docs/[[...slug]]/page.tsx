import { Fragment } from 'react';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/page';
import { source } from '@/lib/docs/source';
import { getMDXComponents } from '@/components/docs/mdx-components';

interface PageProps {
  params: Promise<{ slug?: string[] }>;
}

function EnglishFallback({ children }: { children: React.ReactNode }) {
  return (
    <div lang="en" dir="ltr">
      {children}
    </div>
  );
}

// The locale comes from the cookie, so these pages are per-request (no generateStaticParams).
export default async function Page({ params }: PageProps) {
  const { slug } = await params;
  const locale = await getLocale();
  const page = source.getPage(slug, locale);
  if (!page) notFound();
  const t = await getTranslations('docs');

  const MDX = page.data.body;
  // getPage falls back to `en` when the requested language has no such file; the fallback page's
  // file still lives under content/docs/en/ (parser 'dir'), so compare the path prefix.
  const untranslated = !page.path.startsWith(`${locale}/`);

  // The fallback text is English whatever the reader's language: marked as such (and left to right)
  // so screen readers switch voice and an Arabic page does not mirror it. The notice stays in the
  // reader's language, outside.
  const Content = untranslated ? EnglishFallback : Fragment;

  return (
    <DocsPage toc={page.data.toc}>
      <Content>
        <DocsTitle>{page.data.title}</DocsTitle>
        <DocsDescription>{page.data.description}</DocsDescription>
      </Content>
      {untranslated ? (
        <p data-testid="docs-not-translated" className="rounded-md border bg-muted p-3 text-sm">
          {t('notTranslated')}
        </p>
      ) : null}
      <Content>
        <DocsBody>
          <MDX components={getMDXComponents()} />
        </DocsBody>
      </Content>
    </DocsPage>
  );
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = source.getPage(slug, await getLocale());
  if (!page) notFound();
  return { title: page.data.title, description: page.data.description };
}
