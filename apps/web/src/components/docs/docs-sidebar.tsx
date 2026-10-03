'use client';

import type { ReactNode } from 'react';
import Link from 'fumadocs-core/link';
import { PanelLeft } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { LargeSearchToggle } from 'fumadocs-ui/components/layout/search-toggle';
import {
  Sidebar,
  SidebarContent,
  SidebarContentMobile,
  SidebarFooter,
  SidebarHeader,
  SidebarPageTree,
  SidebarViewport,
} from 'fumadocs-ui/components/layout/sidebar';
import { Navbar } from 'fumadocs-ui/layouts/docs';
import { DocsFooterActions } from './docs-footer-actions';
import { DocsCollapseTrigger, DocsCollapsedControls, DocsSearchToggle, DocsSidebarTrigger } from './docs-controls';

interface BrandProps {
  /** The logo and name, as the layout renders them. */
  title: ReactNode;
  /** Where the dashboard lives: the way out of the docs. */
  url: string;
  /** The app's brand name, for the link's accessible name. */
  brand: string;
}

/** The brand is the only way back to the dashboard, so its name says that and not just the brand. */
function BrandLink({ title, url, brand, className }: BrandProps & { className?: string }) {
  const t = useTranslations('docs.shell');
  return (
    <Link href={url} aria-label={t('backToDashboard', { brand })} className={className}>
      {title}
    </Link>
  );
}

/**
 * The docs sidebar: Fumadocs' own layout (page tree, mobile drawer, collapsing) with controls that are
 * named in the app's languages. The drawer is a dialog; `DocsDrawer` supplies its Escape and focus behaviour.
 */
export function DocsSidebar(props: BrandProps) {
  const t = useTranslations('docs.shell');
  const viewport = (
    <SidebarViewport>
      <SidebarPageTree />
    </SidebarViewport>
  );

  const mobile = (
    <SidebarContentMobile role="dialog" aria-modal="true" aria-label={t('menu')}>
      <SidebarHeader>
        <div className="text-fd-muted-foreground flex items-center gap-1.5">
          <div className="flex flex-1" />
          <DocsFooterActions />
          <DocsSidebarTrigger className="p-2">
            <PanelLeft aria-hidden="true" />
          </DocsSidebarTrigger>
        </div>
      </SidebarHeader>
      {viewport}
      <SidebarFooter className="empty:hidden" />
    </SidebarContentMobile>
  );

  const content = (
    <SidebarContent>
      <SidebarHeader>
        <div className="flex">
          <BrandLink {...props} className="me-auto inline-flex items-center gap-2.5 text-[15px] font-medium" />
          <DocsCollapseTrigger className="text-fd-muted-foreground mb-auto" />
        </div>
        <LargeSearchToggle hideIfDisabled />
      </SidebarHeader>
      {viewport}
      <SidebarFooter>
        <div className="text-fd-muted-foreground flex items-center">
          <DocsFooterActions />
        </div>
      </SidebarFooter>
    </SidebarContent>
  );

  return (
    <Sidebar
      Mobile={mobile}
      Content={
        <>
          <DocsCollapsedControls />
          {content}
        </>
      }
    />
  );
}

/** The top bar below `md`: brand, search, and the button that opens the drawer. */
export function DocsNavbar(props: BrandProps) {
  return (
    <Navbar className="h-(--fd-nav-height) on-root:[--fd-nav-height:56px] md:on-root:[--fd-nav-height:0px] md:hidden">
      <BrandLink {...props} className="inline-flex items-center gap-2.5 font-semibold" />
      <div className="flex-1" />
      <DocsSearchToggle className="p-2" />
      <DocsSidebarTrigger>
        <PanelLeft aria-hidden="true" />
      </DocsSidebarTrigger>
    </Navbar>
  );
}
