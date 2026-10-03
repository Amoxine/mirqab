/**
 * Which documentation page explains which dashboard page: the target of the "Help" link in the page
 * header. Pure data and one lookup, so it can be tested against the content files.
 */

export type DocsSlug =
  | 'apis-and-openapi-import'
  | 'keys-and-plans'
  | 'analytics-and-traffic'
  | 'searching-traffic'
  | 'roles-audit-tenants'
  | 'troubleshooting';

export interface DocsHelp {
  slug: DocsSlug;
  /**
   * A heading id in that page. Headings are slugged from their text, which differs per language, so
   * every language's page carries the same explicit id (`## Heading [#id]`).
   */
  anchor?: string;
}

/** The troubleshooting section for analytics that shows no data, or stale data. */
export const TROUBLESHOOTING_ANALYTICS: DocsHelp = { slug: 'troubleshooting', anchor: 'analytics' };

const APIS: DocsHelp = { slug: 'apis-and-openapi-import' };
const KEYS: DocsHelp = { slug: 'keys-and-plans' };
const ANALYTICS: DocsHelp = { slug: 'analytics-and-traffic' };
const ROLES_AUDIT_TENANTS: DocsHelp = { slug: 'roles-audit-tenants' };

/**
 * Route templates under `app/(dashboard)`; `[id]` stands for any one segment. Matching is exact, so a
 * deeper path is not mapped by its prefix. Left out on purpose: the dashboard home and Settings (no
 * page about them), Certificates (not documented), and `/portal`, which is a separate sign-in domain
 * while `/docs` needs the dashboard's session.
 */
export const DOCS_ROUTES: { route: string; help: DocsHelp }[] = [
  { route: '/apis', help: APIS },
  { route: '/apis/[id]', help: APIS },
  { route: '/keys', help: KEYS },
  { route: '/keys/[id]', help: KEYS },
  { route: '/plans', help: KEYS },
  { route: '/products', help: KEYS },
  { route: '/analytics', help: ANALYTICS },
  { route: '/analytics/traffic', help: ANALYTICS },
  { route: '/analytics/search', help: { slug: 'searching-traffic' } },
  { route: '/audit-logs', help: ROLES_AUDIT_TENANTS },
  { route: '/tenants', help: ROLES_AUDIT_TENANTS },
  { route: '/tenants/[id]', help: ROLES_AUDIT_TENANTS },
  { route: '/settings/roles', help: ROLES_AUDIT_TENANTS },
];

/** Every page (and heading id) the app links to, for the test that checks they exist in each language. */
export const DOCS_TARGETS: DocsHelp[] = [
  ...new Map([...DOCS_ROUTES.map((entry) => entry.help), TROUBLESHOOTING_ANALYTICS].map((help) => [JSON.stringify(help), help])).values(),
];

const segmentsOf = (path: string): string[] => path.split('/').filter(Boolean);

/** The docs entry for a pathname, ids included, or undefined when no page explains it. */
export function docsHelpFor(pathname: string | null): DocsHelp | undefined {
  if (pathname === null) return undefined;
  const actual = segmentsOf(pathname);
  return DOCS_ROUTES.find(({ route }) => {
    const template = segmentsOf(route);
    return template.length === actual.length && template.every((part, i) => part === '[id]' || part === actual[i]);
  })?.help;
}

/** `/docs/<slug>` (the language comes from the `locale` cookie, not the URL), with `#anchor` when there is one. */
export function docsHref({ slug, anchor }: DocsHelp): string {
  return anchor ? `/docs/${slug}#${anchor}` : `/docs/${slug}`;
}
