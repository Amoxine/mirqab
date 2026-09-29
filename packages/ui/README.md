# @open-gateway/ui

Shared, prop-driven React components for the MIRQAB dashboard, built on Radix UI primitives, class-variance-authority and Tailwind CSS v4. Consumed as **source** by `apps/web`: there is no build step, and `main`, `types` and `exports` point at `src/`.

Full reference (export index, props tables, adapter pattern, rules): [`docs/reference/packages.md`](../../docs/reference/packages.md).

## Import path

```tsx
import { Button, Card, CardContent, PageFilter } from '@open-gateway/ui';
```

`@open-gateway/ui` (resolved to `src/index.ts`) is the only public entry; there are no deep imports. The one other export is `@open-gateway/ui/styles.css`.

## Export groups

All exported from `src/index.ts`:

- **Base**: `cn`, `Button` / `buttonVariants`, `Card` family (variant `default` or `ink`), `Table` family, `Progress`, `ToggleGroup`, `WorldMap` (`projectToMap`, `isOnMap`, `WorldMapNode`).
- **shadcn primitives**: `Badge`, `Skeleton`, `Input`, `Textarea`, `Label`, `Switch`, `Checkbox`, `Select`, `Dialog` and `Sheet` (both with a `closeLabel` prop on their content), `DropdownMenu`, `Tooltip`, `Tabs`, `AlertDialog`, `Popover`.
- **Filtering**: `PageFilter` (fields `select` / `search` / `number` / `date` / `segmented`; layouts `card` / `inline` / `popover`), `countActiveFilters`, `SegmentedControl`.
- **Page structure and states**: `PageHeader` (`linkComponent`), `Eyebrow`, `StateMessage` / `StateCard`, `ErrorState`, `Notice`.
- **Data display**: `DataTable`, `DataTablePagination`, `ViewModeToggle`, `useViewMode`, `useMediaQuery`, `StatusBadge`, `MethodBadge`, `Figure` (takes `locale`), `KpiTile` / `KpiTileSkeleton`, `ShareList`, `ChartCard`, `Sparkline`, and the chart helpers `useElementWidth`, `usePrefersReducedMotion`, `fx`, `columnPath`, `niceTicks`.
- **Actions and secrets**: `ConfirmDialog`, `CopyButton`, `SecretField`, `RevealDialog`.

## The one rule

Everything variable comes in as a prop: labels, messages, links (`linkComponent`), locale, data. This package must not import `next-intl`, `next/*`, `@tanstack/react-query` or anything from `apps/web` (it imports only relative paths and npm packages). `apps/web` supplies translations and routing through thin adapters (`apps/web/src/components/ui/*`, `components/shared/{data-table,page-header}.tsx`, `components/dashboard/figure.tsx`, the status-badge wrappers, `hooks/use-page-filter-labels.ts`); the list is in `docs/reference/packages.md`.

## How `apps/web` wires it

- `apps/web/next.config.ts`: `transpilePackages: ['@open-gateway/ui', '@open-gateway/types']`.
- `apps/web/src/styles/globals.css` imports `packages/ui/src/styles.css` (`.surface-ink`, `.ui-pulse-ring`) and adds `@source ../../../../packages/ui/src` so Tailwind scans this package for utility classes.

## Design tokens

The package defines no token values. Colours (`--color-primary`, `--color-card`, `--color-ink`, `--color-grid-dot`, the `success` / `warning` / `info` / `patch` badge tokens and so on) come from the `@theme` block in `apps/web/src/styles/globals.css`. `.surface-ink` in `src/styles.css` re-points the tokens inside dark "ink" cards.

## Adding a component

1. Check the export index in `docs/reference/packages.md` first; start from the shadcn/ui component (new-york style) and do not reinvent one that exists.
2. Create `src/components/<name>.tsx`. Import only relative paths (`../lib/utils`) and npm packages.
3. Use theme tokens, not hex values. Take text, links and locale as props.
4. Export it from `src/index.ts` and add new dependencies to this `package.json`.
5. If it needs i18n, routing or data hooks, write a thin adapter in `apps/web`; otherwise import it directly or add a one-line re-export in `apps/web/src/components/ui/`.
6. Run `pnpm --filter @open-gateway/ui typecheck` and `lint`.

Note: `components.json` still points shadcn at `@ui/components/ui` and `apps/web/src/styles/globals.css`, but components here live flat in `src/components/`. If you use `shadcn add`, move the output and fix its imports.

## Scripts

`lint` (`eslint src/`), `typecheck` (`tsc --noEmit`), `clean`. There is no `build`; a `dist/` folder may exist locally but it is gitignored, stale and unused.

## Dependencies

`@radix-ui/react-*` (one package per primitive), `class-variance-authority`, `clsx`, `lucide-react`, `tailwind-merge`. Peers: `react`, `react-dom` 19 and `@tanstack/react-table` 8 (needed by `DataTable`). `@radix-ui/react-separator` is declared but not imported by any source file.
