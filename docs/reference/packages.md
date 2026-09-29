# Workspace packages reference

Everything here was read from the files cited. Anything not checked is marked "unverified".

## 1. Root tooling

### Workspace and package manager
- `pnpm-workspace.yaml` lists two globs: `apps/*` and `packages/*`. Apps are `apps/api` and `apps/web`.
- `package.json`: `packageManager` is `pnpm@10.4.1`. `engines` requires node `>=20.0.0` and pnpm `>=9.0.0`.
- `pnpm.onlyBuiltDependencies` allows build scripts only for `@prisma/client`, `@prisma/engines`, `@swc/core`, `bcrypt`, `esbuild` and `sharp`. `pnpm.overrides` pins several transitive security versions.
- Every internal dependency uses `workspace:*`.

### Root scripts (`package.json`)
| Script | Runs |
|---|---|
| `dev`, `build`, `start`, `lint`, `lint:fix`, `typecheck`, `test`, `test:watch` | `turbo <task>` |
| `clean` | `turbo clean && rm -rf node_modules .turbo` |
| `format` / `format:check` | `prettier --write` / `--check` on `**/*.{ts,tsx,js,jsx,json,md}` with `--cache` |
| `db:generate`, `db:migrate`, `db:migrate:dev`, `db:seed`, `db:studio` | `pnpm --filter @open-gateway/database <same script>` |
| `infra:up` / `infra:down` / `infra:logs` | `docker compose -f infra/docker-compose.yml up -d` / `down` / `logs -f` |
| `setup` | `bash infra/scripts/setup.sh` |
| `commit` | `cz` (commitizen, `cz-conventional-changelog`) |

### Turbo (`turbo.json`)
- `build` depends on `^build` (dependencies' builds) and `db:generate`. Outputs are `.next/**` (minus `.next/cache/**`) and `dist/**`.
- `lint`, `typecheck` and `test` depend on `^build`. So `packages/types` and `packages/database` are built (tsup) before any app is linted, type-checked or tested.
- `dev` depends on `db:generate`, is persistent and uncached. `start` depends on `build`.
- The `db:*` tasks are uncached. `db:studio` is persistent.
- `globalEnv`: `NODE_ENV`, `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `NEXT_PUBLIC_API_URL`. `globalDependencies`: `**/.env.*local`, `**/.env`.
- No package other than `packages/database` defines `db:generate`. `packages/ui` has no `build` script (see section 2).

### Lint, format, TypeScript
- **ESLint** uses the flat config `eslint.config.js` at the root. It does not import `@open-gateway/config/eslint/base`; it repeats a similar setup inline.
  - Presets: `js.configs.recommended`, `typescript-eslint` `strictTypeChecked` and `stylisticTypeChecked`. `parserOptions.projectService` is on.
  - Rules include `no-console` (warn; `warn` and `error` allowed), `consistent-type-imports`, `no-floating-promises`, and `react/jsx-no-literals` (error, the i18n guard) on `**/*.{jsx,tsx}`.
  - `apps/web/**` adds the Next plugin rules. `apps/web/src/app/portal/**` and `components/portal/**` may not import `**/(dashboard)/**`, `@/components/auth/permission-gate` or `@/hooks/use-permissions`.
  - Ignores include `**/dist/**`, `**/.next/**`, `**/*.config.{js,ts}` and `packages/database/prisma/**`.
  - `apps/web` lint is `next lint --max-warnings 0`. `packages/ui` and `packages/types` lint is `eslint src/`.
- **Prettier**: the root `.prettierrc` is what runs. It has `semi`, `singleQuote`, `tabWidth 2`, `trailingComma all`, `printWidth 100`, `arrowParens always`, `endOfLine lf` and the `prettier-plugin-tailwindcss` plugin. It also holds `importOrder*` keys. Those belong to `@trivago/prettier-plugin-sort-imports`, which is not listed in the root `package.json` devDependencies, so they are probably inert (unverified). `.prettierignore` excludes `packages/database/prisma/migrations`.
- `.editorconfig`: utf-8, LF, 2-space indent.
- **TypeScript**: root `tsconfig.json` is strict (`noUncheckedIndexedAccess`, `noUnusedLocals`, `noEmit`, `jsx: preserve`, and more). `tsconfig.node.json` extends it and compiles to CommonJS.

### Two kinds of workspace package
1. **Consumed as source**: `@open-gateway/ui`. Its `main`, `types` and `exports` point at `./src/index.ts` and `./src/styles.css`. The consuming app compiles it.
2. **Built with tsup**: `@open-gateway/types` and `@open-gateway/database`. Both have `build` = `tsup src/index.ts --format cjs,esm --dts` and resolve to `./dist`. `dist/` is gitignored (`.gitignore`: `packages/*/dist/`).
   - Both apps' Dockerfiles run `pnpm --filter @open-gateway/database build` (`apps/api/Dockerfile`, `apps/web/Dockerfile`).
   - `apps/web/Dockerfile` copies `packages/{types,database,ui}/package.json`. It builds only the database package explicitly. `types` gets built by turbo's `^build` in a turbo run. I did not verify how a docker-only build gets `types/dist`.
   - `apps/web/next.config.ts` lists `transpilePackages: ['@open-gateway/ui', '@open-gateway/types']`.

## 2. `@open-gateway/ui` (`packages/ui`)

Shared, prop-driven React components for the design system. It is used by `apps/web` only. `apps/web/package.json` depends on it, and `apps/api` does not.

### Layout
```
packages/ui/
  package.json      main/types -> ./src/index.ts ; exports "." and "./styles.css"
  components.json   shadcn config (see caveats)
  tsconfig.json     extends @open-gateway/config/tsconfig/base.json ; paths "@ui/*" -> ./src/*
  src/index.ts      barrel: the only public entry
  src/lib/          utils.ts (cn), use-media-query.ts (useMediaQuery), viz.ts (chart helpers)
  src/styles.css    .surface-ink + .ui-pulse-ring animation
  src/components/   40 component .tsx files + world-map-data.ts (flat, no ui/ subfolder); see the index below
```
Scripts: `lint` = `eslint src/`, `typecheck` = `tsc --noEmit`, `clean`. There is **no `build` script**. `packages/ui/dist/` contains `index.{js,mjs,d.ts,d.mts}` but is gitignored and nothing in `package.json` produces it, so it is a stale artifact. The package entry points do not use it.

Runtime dependencies (`package.json`): fourteen `@radix-ui/react-*` packages, `class-variance-authority`, `clsx`, `lucide-react`, `tailwind-merge`. Peers: `react`, `react-dom` `^19` and `@tanstack/react-table` `^8.21.2` (needed by `DataTable`; also a devDependency so the package typechecks alone). `@radix-ui/react-separator` is declared but no file in `packages/ui/src` imports it (verified by grep); every other declared Radix package is imported by at least one file.

### How `apps/web` consumes it
1. **Source transpile**: `apps/web/next.config.ts` has `transpilePackages: ['@open-gateway/ui', '@open-gateway/types']`, so Next compiles the TS/TSX in `packages/ui/src` directly.
2. **CSS**: the top of `apps/web/src/styles/globals.css` is:
   ```css
   @import 'tailwindcss';
   @import 'tw-animate-css';
   @import '../../../../packages/ui/src/styles.css';
   @source '../../../../packages/ui/src';
   ```
   - The `@import` brings in `.surface-ink` and `.ui-pulse-ring`.
   - The `@source` directive tells Tailwind v4 to scan `packages/ui/src` for class names. Without it, utilities used only inside the package would be missing from the CSS.
3. **Theme tokens live in the app**: the `@theme` block in `apps/web/src/styles/globals.css` defines `--color-primary`, `--color-card`, `--color-ink`, `--color-grid-dot` and so on. The package ships no token values of its own. `src/index.ts` says as much.
4. **Adapters**: `apps/web/src/components/ui/*` and a few files under `components/shared|dashboard|apis|keys` re-export or wrap the package; see [The adapter pattern](#the-adapter-pattern).

### Exports (`packages/ui/src/index.ts`)

`src/index.ts` is the only public entry (`import { … } from '@open-gateway/ui'`). Files are under `packages/ui/src/`. Compound shadcn families are listed once.

| Export | File | Purpose |
|---|---|---|
| `cn` | `lib/utils.ts` | `twMerge(clsx(...))` |
| `Button`, `buttonVariants`, `ButtonProps` | `components/button.tsx` | Round button; `loading`, `asChild` |
| `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`, `cardVariants`, `CardProps` | `components/card.tsx` | Card; variant `default` or `ink` |
| `Table`, `TableHeader`, `TableBody`, `TableFooter`, `TableHead`, `TableRow`, `TableCell`, `TableCaption` | `components/table.tsx` | Styled table elements |
| `WorldMap`, `WorldMapNode`, `projectToMap`, `isOnMap` | `components/world-map.tsx` | Dot-matrix gateway map |
| `Progress` | `components/progress.tsx` | Bar with `indicatorClassName` |
| `ToggleGroup`, `ToggleGroupItem` | `components/toggle-group.tsx` | Radix toggle group |
| `Badge`, `badgeVariants`, `BadgeProps` | `components/badge.tsx` | Chip; variants `default`, `secondary`, `destructive`, `success`, `warning`, `info`, `patch`, `muted`, `outline` |
| `Skeleton` | `components/skeleton.tsx` | Loading placeholder |
| `Input`, `Textarea`, `Label`, `Switch`, `Checkbox` | `components/{input,textarea,label,switch,checkbox}.tsx` | Form primitives |
| `Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectGroup`, `SelectItem`, `SelectLabel`, `SelectSeparator`, `SelectScrollUpButton`, `SelectScrollDownButton` | `components/select.tsx` | Radix select |
| `Dialog` family (`DialogContent` takes `closeLabel`) | `components/dialog.tsx` | Modal dialog |
| `Sheet` family (`SheetContent` takes `side`, `closeLabel`) | `components/sheet.tsx` | Side panel; the create/edit form surface |
| `AlertDialog` family | `components/alert-dialog.tsx` | Destructive-confirmation primitive (used by `ConfirmDialog`) |
| `DropdownMenu` family | `components/dropdown-menu.tsx` | Menu |
| `Tooltip`, `TooltipTrigger`, `TooltipContent`, `TooltipProvider` | `components/tooltip.tsx` | Tooltip |
| `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | `components/tabs.tsx` | Tabs |
| `Popover`, `PopoverTrigger`, `PopoverContent` | `components/popover.tsx` | Popover |
| `PageFilter`, `countActiveFilters`, field/value/label types | `components/page-filter.tsx` | Config-driven filter bar |
| `SegmentedControl`, `SegmentedOption`, `SegmentedControlProps` | `components/segmented-control.tsx` | Single-select chip row |
| `StateMessage`, `StateCard`, `StateMessageProps` | `components/state-card.tsx` | Empty / error / not-found body |
| `PageHeader`, `PageHeaderProps` | `components/page-header.tsx` | Title row, badges, actions, back link |
| `Eyebrow` | `components/eyebrow.tsx` | Mono uppercase caption |
| `KpiTile`, `KpiTileSkeleton`, `KpiTileProps` | `components/kpi-tile.tsx` | Compact KPI tile |
| `Notice`, `NoticeProps` | `components/notice.tsx` | Inline tinted callout |
| `ShareList`, `ShareItem`, `ShareListProps` | `components/share-list.tsx` | Label / value rows over progress bars |
| `Sparkline`, `SparklineProps` | `components/sparkline.tsx` | Decorative 2px trend line |
| `useElementWidth`, `usePrefersReducedMotion`, `fx`, `columnPath`, `niceTicks` | `lib/viz.ts` | Chart helpers (SVG path formatting, ticks, width, reduced motion) |
| `ConfirmDialog`, `ConfirmDialogProps` | `components/confirm-dialog.tsx` | Confirmation that stays open while the action runs |
| `CopyButton`, `CopyButtonProps` | `components/copy-button.tsx` | Copy to clipboard with a check-mark |
| `SecretField`, `SecretFieldProps` | `components/secret-field.tsx` | Monospace, select-all value |
| `RevealDialog`, `RevealDialogProps` | `components/reveal-dialog.tsx` | "Shown only once" secret dialog |
| `DataTable`, `DataTableProps`, `DataTableLabels`, `DataTablePagination`, `DataTablePaginationProps`, `ViewModeToggle`, `ViewModeLabels`, `useViewMode`, `ViewMode` | `components/data-table.tsx` | TanStack table chrome, table/card views, pagination |
| `useMediaQuery` | `lib/use-media-query.ts` | SSR-safe `matchMedia` hook |
| `ErrorState`, `ErrorStateProps` | `components/error-state.tsx` | Failed load with retry |
| `ChartCard`, `ChartCardProps` | `components/chart-card.tsx` | Card whose body is loading / error / empty / chart |
| `MethodBadge` | `components/method-badge.tsx` | HTTP verb chip |
| `Figure`, `FigureProps` | `components/figure.tsx` | Number with a small unit, in a given locale |
| `StatusBadge`, `StatusBadgeProps` | `components/status-badge.tsx` | Status to variant and label lookup |

Not exported: `WORLD_MAP` (`world-map-data.ts`). `components/dialog.tsx` and `sheet.tsx` default `closeLabel` to the English string `Close`; apps should pass a translated one (see the adapter pattern).

### Core components: Button, Card, Table, Progress, ToggleGroup, WorldMap

All components forward `ref`. Unlisted props are passed through to the underlying element.

**Button** (`src/components/button.tsx`). Element: `<button>`, or the child element when `asChild` is set.
| Prop | Type | Default | Notes |
|---|---|---|---|
| `variant` | `default` \| `destructive` \| `outline` \| `secondary` \| `ghost` \| `link` | `default` | |
| `size` | `default` (h-9) \| `sm` (h-8) \| `lg` (h-11) \| `icon` (size-9) | `default` | |
| `asChild` | `boolean` | `false` | Renders through Radix `Slot`; no spinner and no `disabled` handling in this mode. |
| `loading` | `boolean` | `false` | Disables the button, sets `aria-busy`, and shows a `Loader2` spinner before the label. |
| other | `React.ButtonHTMLAttributes` | | `disabled` is OR-ed with `loading`. |

All variants are `rounded-full`. Coarse pointers get a `min-h-11` target.

**Card** (`src/components/card.tsx`). Element: `<div>`.
| Prop | Type | Default | Notes |
|---|---|---|---|
| `variant` | `default` \| `ink` | `default` | `default` = `border bg-card shadow-sm`. `ink` = the `.surface-ink` class. |
| other | `HTMLAttributes<HTMLDivElement>` | | Base class is `rounded-[1.25rem] text-card-foreground`. |

`CardHeader`, `CardTitle`, `CardDescription`, `CardContent` and `CardFooter` are `<div>`s with padding and typography classes and no variants. `CardTitle` is a `div`, not a heading, so add your own heading semantics if needed.

`ink` is a dark surface **in both themes**. `.surface-ink` in `src/styles.css` re-points `--color-card`, `--color-foreground`, `--color-muted-foreground`, `--color-border`, `--color-muted`, `--color-accent`, `--color-secondary`, `--color-primary`, `--color-ring`, the status colours (`success`, `warning`, `info`, `destructive`, `danger`) and their foregrounds. Anything inside keeps working on the dark fill with no per-component overrides. It reads `--color-ink` and `--color-secondary-foreground` from the app theme. A `[dir='rtl']` rule mirrors the gradient corner. Used in `apps/web` by `traffic-breakdowns.tsx` and `overview-panel.tsx`.

**Table family** (`src/components/table.tsx`). No variants.
| Component | Element | Notes |
|---|---|---|
| `Table` | `<table>` inside a `div.relative.w-full.overflow-auto` | `tabular-nums`, `caption-bottom` |
| `TableHeader` / `TableBody` / `TableFooter` | `thead` / `tbody` / `tfoot` | |
| `TableRow` | `tr` | Rows have no rules. Hover and `data-[state=selected]` paint a rounded pill across the row. |
| `TableHead` | `th` | Mono, uppercase, small |
| `TableCell` | `td` | |
| `TableCaption` | `caption` | |

**Progress** (`src/components/progress.tsx`, `'use client'`). Wraps Radix `Progress.Root`.
| Prop | Type | Default | Notes |
|---|---|---|---|
| `value` | `number` \| `null` | undefined, so the bar is at 0% | 0 to 100 assumed; `translateX(-(100 - value)%)` |
| `indicatorClassName` | `string` | | Recolours the bar, for example `bg-warning`. |
| other | Radix `Progress.Root` props | | |

Track is `h-1 rounded-full bg-muted`. Indicator is `bg-primary`.

**ToggleGroup / ToggleGroupItem** (`src/components/toggle-group.tsx`, `'use client'`). Wrap Radix `ToggleGroup.Root` / `Item`, so props are Radix's (`type: 'single' | 'multiple'` is required, plus `value`, `onValueChange`, `defaultValue`, and `value` on items). Styling is a round segmented control. The active item gets `bg-card` with a ring.

**WorldMap** (`src/components/world-map.tsx`, `'use client'`).
| Prop | Type | Default | Notes |
|---|---|---|---|
| `nodes` | `WorldMapNode[]` | required | Nodes outside the crop (`isOnMap` false) are dropped. |
| `label` | `string` | required | `aria-label` on the `role="img"` wrapper. Pins are `aria-hidden`, so describe the nodes here and list them as text nearby. |
| `className` | `string` | | |
| `cover` | `boolean` | `false` | Fill the parent's box (it needs a definite size). The map is scaled to cover, cropped and centred on the nodes. Without it the map is full width at a 128:67 aspect ratio. |

`WorldMapNode`:
| Field | Type | Notes |
|---|---|---|
| `id` | `string` | React key and redraw signature |
| `title` | `string` | Main line of the label card |
| `code` | `string?` | Small mono line above the title |
| `detail` | `string?` | Small mono line below the title |
| `lat`, `lon` | `number` | |
| `up` | `boolean` | `false` = destructive colour, no pulse |
| `placement` | `'above'` \| `'below'` \| `'start'`? | Default `above` |

Behaviour worth knowing:
- The map is drawn on a `<canvas>` (graticule, land dots, per-node glow).
- It reads `--color-muted-foreground`, `--color-grid-dot` and `--color-primary` from the computed style, and the `dark` class on `<html>`. It redraws on resize and when the class changes.
- Geometry is forced `dir="ltr"`.
- The `cover` mode uses CSS container query units (`cqw`/`cqh`).

**`projectToMap(lat, lon)`** returns `[x, y]` as fractions (0 to 1) of the map's width and height.
**`isOnMap(lat, lon)`** is true when that point falls inside the crop.

### Composite components: props

Prop tables below were read from the `*Props` interfaces. Unlisted props are not accepted unless the row says "extends".

#### `PageFilter` (`components/page-filter.tsx`)

One dynamic filter bar for any page that filters a list, table or chart. It is **controlled and presentational**: the page owns the values (URL params, `useState`…), describes the controls as data (`fields`), and receives changes as a patch. No i18n, routing or fetching inside.

| Prop | Type | Default | Notes |
|---|---|---|---|
| `fields` | `FilterField[]` | required | Controls, in order. |
| `values` | `FilterValues` (`Record<string, string \| number \| undefined>`) | required | Current value per field `key`. |
| `onChange` | `(patch: FilterValues) => void` | required | Only what changed; a cleared field arrives as `key: undefined`. |
| `onReset` | `() => void` | required | Called by the Reset button. |
| `labels` | `PageFilterLabels` | required | `title` (search landmark in `card`, trigger text in `popover`), `reset`, `active(count)` (the "N filters active" string; pluralisation is the caller's). |
| `layout` | `card` \| `inline` \| `popover` | `card` | `card`: bordered card, segmented fields in a toolbar row with the active-count text and Reset, the rest in a labelled grid (`sm:grid-cols-2 lg:grid-cols-4`). `inline`: one wrapping row of compact controls; Reset appears only while something is active. `popover`: a "Filters" button with an active-count `Badge`; fields open in a `w-80` panel with visible labels and a Reset button. |
| `showReset` | `boolean` | `true` | `inline` only: whether the row renders its own Reset. Turn off where the page has another clear action (e.g. in the empty state). |
| `className` | `string` | | On the root (card / row / trigger button). |

Field types (`FilterField` is the union). Every field has `key`, `label` (visible caption in card/popover, accessible name everywhere), optional `className`, and optional `countAsFilter` (whether an active value counts towards the tally and enables Reset; default `true` except for `segmented`, because a time range always applies).

| `type` | Extra props | Emits |
|---|---|---|
| `select` | `options: {value,label}[]`, `allLabel` (text of the "no filter" entry), `valueType?: 'string' \| 'number'`, `disabled?` | Selected value, or `undefined` for the "all" entry (the internal `__all__` sentinel never leaves the component). `valueType: 'number'` emits `Number(value)`. |
| `search` | `placeholder?`, `maxLength?`, `dir?: 'ltr' \| 'rtl' \| 'auto'`, `debounceMs?` | Text, or `undefined` when blank. Debounced by `debounceMs` (default 350); `0` fires on every keystroke (right for client-side filtering). The draft re-syncs when the parent value changes (back button, Reset). |
| `number` | `placeholder?`, `min?`, `max?`, `maxDigits?` (default digits of `max`, else 9), `debounceMs?` | An integer, or `undefined` when the draft is empty or outside `min`..`max`. Input is digits-only, `dir="ltr"`. |
| `date` | none | `YYYY-MM-DD` string from `<input type="date">`, or `undefined`. |
| `segmented` | `options: {value,label: ReactNode,title?}[]` | The chosen value (never cleared; built on `SegmentedControl`). |

`countActiveFilters(fields, values)` returns how many filters currently narrow the view (same rule as the tally). The exported types are `FilterValue`, `FilterValues`, `FilterField`, `SelectFilterField`, `SearchFilterField`, `NumberFilterField`, `DateFilterField`, `SegmentedFilterField`, `PageFilterLabels`, `PageFilterProps`.

```tsx
import { useState } from 'react';
import {
  PageFilter,
  countActiveFilters,
  type FilterField,
  type FilterValues,
} from '@open-gateway/ui';

const fields: FilterField[] = [
  { type: 'search', key: 'q', label: 'Search', placeholder: 'Name or path' },
  {
    type: 'select',
    key: 'status',
    label: 'Status',
    allLabel: 'All statuses',
    options: [
      { value: 'ACTIVE', label: 'Active' },
      { value: 'DRAFT', label: 'Draft' },
    ],
  },
  { type: 'number', key: 'status_code', label: 'Status code', min: 100, max: 599 },
];

export function ApiFilters() {
  const [values, setValues] = useState<FilterValues>({});
  return (
    <PageFilter
      layout="inline"
      fields={fields}
      values={values}
      onChange={(patch) => {
        setValues((current) => ({ ...current, ...patch }));
      }}
      onReset={() => {
        setValues({});
      }}
      labels={{
        title: 'Filters',
        reset: 'Clear filters',
        active: (count) => `${count} filters active`,
      }}
    />
  );
}
// countActiveFilters(fields, values) === number of non-empty non-segmented values
```

#### `ConfirmDialog` (`components/confirm-dialog.tsx`)

Radix closes an `AlertDialog` as soon as the action is pressed; this holds it open until the caller's work settles and refuses dismissal (overlay, Escape, Cancel) while `isPending`.

| Prop | Type | Default | Notes |
|---|---|---|---|
| `open`, `onOpenChange` | `boolean`, `(open) => void` | required | `onOpenChange` is not called while `isPending`. |
| `title`, `description` | `ReactNode` | required | |
| `confirmLabel`, `cancelLabel` | `ReactNode` | required | |
| `pendingLabel` | `ReactNode` | `confirmLabel` | Shown on the confirm button while pending. |
| `isPending` | `boolean` | `false` | Disables both buttons. |
| `onConfirm` | `() => void \| Promise<void>` | required | The dialog stays open; close it from here when the work settles. |
| `tone` | `destructive` \| `default` | `destructive` | `destructive` styles the confirm button with `bg-destructive`. |
| `children` | `ReactNode` | | Extra body under the description (a checkbox, a warning). |

#### `RevealDialog` (`components/reveal-dialog.tsx`)

"Copy this now, it is shown only once." Composes `Dialog`, `SecretField` and `CopyButton`. Nothing stores or refetches the value.

| Prop | Type | Notes |
|---|---|---|
| `value` | `string \| null` | The secret; `null` keeps the dialog closed. |
| `onClose` | `() => void` | Called on dismissal and by the Done button. |
| `title`, `description` | `ReactNode` | |
| `copyLabel`, `copiedLabel`, `doneLabel` | `string` | |
| `closeLabel` | `string?` | Screen-reader text of the corner close button (passed to `DialogContent`). |
| `onCopyError` | `() => void` | Clipboard write refused. |
| `valueTestId` | `string?` | `data-testid` on the value. |
| `children` | `ReactNode` | More content under the value. |

#### `DataTable`, `DataTablePagination`, `ViewModeToggle`, `useViewMode` (`components/data-table.tsx`)

`@tanstack/react-table` is a **peer dependency**: the caller builds the `useReactTable` instance (columns, data, models); the component only renders it. Labels are props, so nothing is translated here.

`DataTableProps<TData>`:

| Prop | Type | Default | Notes |
|---|---|---|---|
| `table` | `Table<TData>` | required | From `useReactTable`. |
| `labels` | `DataTableLabels` | required | `retry`, `unexpectedError` (used when the error has no message). |
| `isLoading`, `isError` | `boolean` | required | Body is a skeleton, an alert with retry, the empty message, or the rows. |
| `error` | `Error \| null` | | Its `message` is shown on error. |
| `onRetry` | `() => void` | | Retry button is rendered only when given. |
| `emptyMessage` | `string` | required | |
| `emptyAction` | `ReactNode` | | Next step under the empty message (e.g. a create button). |
| `skeletonRows` | `number` | `5` | Card skeleton shows `min(skeletonRows, 3)`. |
| `viewMode` | `'table' \| 'card'` | `table` | Card view needs `renderCard`. |
| `renderCard` | `(row: TData) => ReactNode` | | Optional. Below `sm` (`max-width: 639px`, via `useMediaQuery`) rows always render as cards: `renderCard` if given, else an auto card built from the column headers (a header-less column goes to the top corner). |

Other exports:

| Export | Props / returns |
|---|---|
| `DataTablePagination` | `page`, `totalPages`, `summary: ReactNode` (formatted by the caller), `previousLabel`, `nextLabel`, `onPrevious`, `onNext`. Previous disabled at page 1, Next at `page >= totalPages`. |
| `ViewModeToggle` | `mode`, `onChange`, `labels: ViewModeLabels` (`group`, `table`, `card`). Hidden below `sm`. |
| `useViewMode(storageKey)` | `[mode, setMode]`; persisted per key in `localStorage`, read after mount (no hydration mismatch), every access guarded. |

The file's header comment freezes the `ViewMode` union, the `useViewMode` return shape, the `ViewModeToggle` prop names and the optionality of `renderCard`; markup and the storage mechanism are free to change.

#### `StatusBadge` (`components/status-badge.tsx`)

Generic over the status union `T extends string`.

| Prop | Type | Notes |
|---|---|---|
| `status` | `T` | Current status. |
| `variants` | `Record<T, BadgeProps['variant']>` | Badge variant per status; a missing key is a type error. |
| `labels` | `Record<T, ReactNode>` | Visible text per status (translated by the caller). |
| `className` | `string?` | |

#### `Notice` (`components/notice.tsx`)

| Prop | Type | Default | Notes |
|---|---|---|---|
| `tone` | `warning` \| `info` \| `destructive` \| `success` | `warning` | Sets tint and default icon (`AlertTriangle`, `Info`, `AlertCircle`, `CheckCircle2`). |
| `title` | `ReactNode` | | Bold first line; children render muted below it. |
| `children` | `ReactNode` | | Explanation. |
| `action` | `ReactNode` | | Button or link on the end side. |
| `role` | `status` \| `alert` \| `note` | none | `alert` for a failure, `status` for something that appears on its own. |
| `className` | `string` | | |
| `icon` | component | | Declared in `NoticeProps` but **not destructured or used** by the component (verified: the render always uses the tone icon). Treat as a dead prop. |

#### `PageHeader` (`components/page-header.tsx`)

| Prop | Type | Notes |
|---|---|---|
| `title` | `ReactNode` | The page `<h1>`. |
| `badges` | `ReactNode` | Beside the title. |
| `description` | `ReactNode` | Muted line under it. |
| `actions` | `ReactNode` | Wraps under the title on narrow screens. |
| `back` | `{ href: string; label: string }` | Ghost "back" link with an arrow that mirrors in RTL. |
| `linkComponent` | `ElementType` | Element for the back link; defaults to `'a'`. Pass `next/link` to keep navigation client-side. |

#### `KpiTile` and `KpiTileSkeleton` (`components/kpi-tile.tsx`)

| Prop | Type | Default | Notes |
|---|---|---|---|
| `label` | `string` | required | Shown as an `Eyebrow`. |
| `value` | `ReactNode` | required | The figure (`tabular-nums`). |
| `hint` | `ReactNode` | | One line of context. |
| `icon` | component | | Small icon at the label's end. |
| `tone` | `default` \| `good` \| `warn` \| `bad` | `default` | Colours the figure (`text-success`, `text-warning`, `text-destructive`). |
| `className` | `string` | | |

`KpiTileSkeleton` takes no props and has the same footprint.

#### `ShareList` (`components/share-list.tsx`)

| Prop | Type | Notes |
|---|---|---|
| `items` | `ShareItem[]` | `{ key, label, value, indicatorClassName? }` (a `bg-*` class for the bar). |
| `total` | `number?` | Denominator; default the sum of the items. A zero total gives 0% shares. |
| `format` | `(value, share) => string` | Text at the end of each row; `share` is 0 to 100. |
| `className` | `string?` | |

#### `SegmentedControl` (`components/segmented-control.tsx`)

Generic over `T extends string`; built on `ToggleGroup`. The active chip cannot be pressed off, so a value is always selected.

| Prop | Type | Notes |
|---|---|---|
| `value` | `T` | |
| `onChange` | `(value: T) => void` | |
| `options` | `{ value: T; label: ReactNode; title?: string }[]` | `title` is the hover text. |
| `ariaLabel` | `string` | Accessible name of the group. |
| `className` | `string?` | |

#### `ChartCard` (`components/chart-card.tsx`)

A card whose body is never an empty canvas.

| Prop | Type | Default | Notes |
|---|---|---|---|
| `title`, `description` | `string` | required | Also form the `aria-label` of the chart (`role="img"`). |
| `status` | `loading` \| `error` \| `empty` \| `ready` | required | Skeleton, `errorContent`, `emptyContent`, or `children`. |
| `errorContent`, `emptyContent` | `ReactNode` | | |
| `heightClass` | `string` | `h-[280px]` | Tailwind class of the body box. |
| `children` | `ReactNode` | required | The chart; use `<ResponsiveContainer height="100%">`. |

#### `ErrorState` (`components/error-state.tsx`)

`title`, `message`, `retryLabel` (all `string`), `onRetry: () => void`, `className?`. Renders `role="alert"` with an icon, both texts and a retry button.

#### `CopyButton` (`components/copy-button.tsx`)

Extends `ButtonProps` minus `onClick`, `children`, `value`.

| Prop | Type | Default | Notes |
|---|---|---|---|
| `value` | `string` | required | Text written to the clipboard. |
| `label` | `string` | required | Visible label; the `aria-label` when `iconOnly`. |
| `copiedLabel` | `string` | `label` | Label after a successful copy. |
| `onCopyError` | `() => void` | | Clipboard refused (no permission, insecure context). |
| `iconOnly` | `boolean` | `false` | Uses `size="icon"`. |
| `resetAfterMs` | `number` | stay "copied" | Timer back to idle. The copied state also resets whenever `value` changes. |
| `variant`, `size` | Button props | `outline`, `sm` | |

#### Smaller pieces

| Export | Props / behaviour |
|---|---|
| `SecretField` | `value`, `label?`; extends `HTMLAttributes` (spread on the `<code>`). `dir="ltr"`, `select-all`, `break-all`. |
| `StateMessage` / `StateCard` | `icon?`, `title?`, `message?`, `children?` (the next action), `className?`, `role?: 'alert' \| 'status'`. `StateCard` wraps it in a `Card`. |
| `MethodBadge` | `method: string`. Upper-cased; GET success, POST info, PUT warning, PATCH patch, DELETE destructive, HEAD default, OPTIONS/TRACE/CONNECT and anything unknown muted. Never translated. |
| `Figure` | `value: number`, `kind: 'compact' \| 'percent' \| 'ms'`, `locale: string`, `className?`. `percent` takes 0 to 100. Unit, compact suffix and % sign are rendered small. |
| `Sparkline` | `values: number[]`, `area?`, `height?` (44), `className?`. Decorative (`aria-hidden`), always `dir="ltr"`. |
| `Eyebrow` | `span` props; the mono caption style. |
| `useMediaQuery(query)` | `useSyncExternalStore` over `matchMedia`; server snapshot is `false`, and environments without `matchMedia` report `false`. |
| `lib/viz.ts` | `useElementWidth<T>()` returns `[ref, width]`; `usePrefersReducedMotion()`; `fx(n)` two-decimal SVG coordinate; `columnPath(x, y, w, base, radius = 4)`; `niceTicks(max, count = 3)` returns `{ top, ticks }`. |
| `Dialog` / `Sheet` content | `DialogContent` and `SheetContent` accept `closeLabel` (default `Close`); `SheetContent` also `side: top \| bottom \| left \| right` (default `right`). |

### The adapter pattern

`packages/ui` **must not import** `next-intl`, `next/*` (including `next/link`), `@tanstack/react-query`, or anything from `apps/web`. A grep of `packages/ui/src` for `next-intl`, `next`, `react-query`, `@/` and `apps/web` found no matches (verified). So a component that needs translated text, the router or data gets those as props, and `apps/web` keeps a **thin adapter**: a file that reads the hook (`useTranslations`, `useLocale`, `Link`) and forwards to the package component. Call sites stay unchanged.

Adapters in `apps/web/src` (all read from those files):

| App file | Kind | What it adds |
|---|---|---|
| `components/ui/dialog.tsx` | wrapper | `DialogContent` with `closeLabel={t(close)}` (`common` messages); other parts re-exported |
| `components/ui/sheet.tsx` | wrapper | `SheetContent` with the same translated `closeLabel` |
| `components/shared/data-table.tsx` | wrapper | `DataTable` (supplies `labels`: `common.retry`, `dashboard.dataTable.unexpectedError`), `DataTablePagination` (builds `summary` from `dashboard.dataTable.pageOf` / `totalCount`, and the previous/next labels; takes `totalCount`), `ViewModeToggle` (supplies `labels`); `useViewMode` and `ViewMode` re-exported |
| `components/shared/page-header.tsx` | wrapper | `PageHeader` with `linkComponent={Link}` from `next/link` |
| `components/dashboard/figure.tsx` | wrapper | `Figure` with `locale={useLocale()}` |
| `components/dashboard/range-control.tsx` | app component | `SegmentedControl` fed by `ANALYTICS_RANGES` and the `dashboard.page` / `analytics` messages |
| `components/apis/api-status-badge.tsx` | wrapper | `StatusBadge` with the `ACTIVE`/`DRAFT`/`DISABLED` variant map and `apis.status.*` labels |
| `components/keys/key-status-badge.tsx` | wrapper | `StatusBadge` for `ACTIVE`/`REVOKED`/`EXPIRED` with `keys.status.*` labels |
| `components/analytics/analytics-empty-state.tsx` | wrapper (partial) | `ChartCard` (app signature `isLoading`/`error`/`onRetry`/`isEmpty`/`emptyMessage` mapped onto `status`) and `AnalyticsErrorState` built on `ErrorState`; also uses `Notice` |
| `hooks/use-page-filter-labels.ts` | hook | `usePageFilterLabels(resetLabel?)` returns `PageFilterLabels` from `common.filters`, `common.clearFilters`, `common.activeFilters` |
| `hooks/use-media-query.ts` | re-export + hook | re-exports `useMediaQuery`; adds `usePrefersReducedMotion` on top of it |

Pure re-exports (no logic, only preserve the `@/components/...` import path):

- `components/ui/`: `alert-dialog`, `badge`, `button`, `card`, `checkbox`, `dropdown-menu`, `input`, `label`, `popover`, `progress`, `select`, `skeleton`, `switch`, `table`, `tabs`, `textarea`, `toggle-group`, `tooltip`.
- `components/shared/state-card.tsx` (`StateCard`, `StateMessage`), `components/dashboard/kpi-tile.tsx` (`KpiTile`, `KpiTileSkeleton`), `components/dashboard/sparkline.tsx`, `components/apis/endpoints/method-badge.tsx`.
- `components/dashboard/viz-utils.ts` re-exports the `lib/viz` helpers and adds the app-only `bucketErrorRate`.

Not part of the package (app-local, no `@open-gateway/ui` import): `components/ui/avatar`, `command`, `form`, `scroll-area`, `sonner`. Components used **directly** from the package with no adapter (they take their text as props at the call site): `ConfirmDialog` (nine `*-dialog.tsx` files, driven by `lib/confirm-action.ts`), `RevealDialog` (`keys/key-created-dialog.tsx`, `portal/key-reveal-dialog.tsx`), `PageFilter`, `CopyButton`, `Notice`, `ShareList`, `ErrorState`, `WorldMap`.

### `world-map-data.ts` (the crop)
Exports one const, `WORLD_MAP`. It holds a hex-packed one-bit land mask from Natural Earth, per its header comment.
| Field | Value |
|---|---|
| `cols` x `rows` | 128 x 67 cells |
| `lon0` | -92 |
| `lat1` | 64 |
| `step` | 0.75 degrees per cell |
| `k` | 0.7771459614569709 (longitude squeeze so cells look square) |
| `data` | string; 4 cells per hex digit, row by row |

The crop runs from lon -92 to about 31.5 and lat 64 down to 14. That covers the Americas' east coast, the Atlantic, Europe and NW Africa. `LON_SPAN = cols*step/k` and `LAT_SPAN = rows*step`. `WORLD_MAP` is not re-exported from `index.ts`. The doc comment in `world-map.tsx` matches these numbers.

### Usage snippets (written against the actual exports)
```tsx
import {
  Button, Card, CardContent, CardHeader, CardTitle,
  Progress, ToggleGroup, ToggleGroupItem,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
  WorldMap, isOnMap, projectToMap, type WorldMapNode,
} from '@open-gateway/ui';

// Button: loading state and asChild
<Button variant="outline" size="sm" loading={pending}>Save</Button>
<Button asChild variant="link"><a href="/docs">Docs</a></Button>

// Card: the dark emphasis surface
<Card variant="ink" className="p-4">
  <CardHeader><CardTitle>Traffic</CardTitle></CardHeader>
  <CardContent>...</CardContent>
</Card>

// Progress with a recoloured bar
<Progress value={82} indicatorClassName="bg-warning" />

// ToggleGroup (Radix props; `type` is required)
<ToggleGroup type="single" value={range} onValueChange={(v) => v && setRange(v)}>
  <ToggleGroupItem value="24h">24h</ToggleGroupItem>
  <ToggleGroupItem value="7d">7d</ToggleGroupItem>
</ToggleGroup>

// Table
<Table>
  <TableHeader><TableRow><TableHead>Path</TableHead></TableRow></TableHeader>
  <TableBody><TableRow><TableCell>/payments/</TableCell></TableRow></TableBody>
</Table>

// WorldMap
const nodes: WorldMapNode[] = [
  { id: 'n1', title: 'Frankfurt', code: 'FRA', lat: 50.1, lon: 8.7, up: true },
];
<div className="h-64">
  <WorldMap cover nodes={nodes} label="Gateway nodes: Frankfurt" />
</div>;
const [x, y] = projectToMap(50.1, 8.7); // fractions of width/height
isOnMap(50.1, 8.7); // true
```
In `apps/web` you can also use the shim paths, for example `import { Button } from '@/components/ui/button'`.

### Rules for adding a component
Derived from the source and from the global rules in `~/.claude/CLAUDE.md`:
1. **shadcn first, then reuse first.** Check the index above before writing any control. Start from the shadcn component (new-york style, per `components.json`) and adapt it.
2. **No app knowledge.** Files in `packages/ui/src` import only relative paths (`../lib/utils`) and npm packages. Never `next-intl`, `next/*`, `@tanstack/react-query`, `@/...` or anything from `apps/web`. A grep of `packages/ui/src` for those found none at the time of writing (verified). There is no lint rule enforcing it in `packages/ui` (the `lint` script is plain `eslint src/`; no restriction config found, unverified for the root config).
3. **Everything variable arrives as a prop.** Labels and messages are strings or `ReactNode`; links are a `linkComponent` prop (`PageHeader`); locale is a `locale` prop (`Figure`); pluralised text is a function (`PageFilterLabels.active`); data comes in as arrays or a ready `useReactTable` instance. Zero hardcoded user-facing strings; the two known defaults are the English `Close` in `DialogContent` / `SheetContent`.
4. **Tokens, not literals.** Colours are Tailwind utilities (`bg-card`, `text-muted-foreground`, `bg-success`) or `var(--color-*)`. The only hex values are the `.surface-ink` re-pointing in `src/styles.css`. New tokens go in the app's `@theme` block.
5. **File conventions.** `src/components/<name>.tsx`; `cn` from `../lib/utils`; `forwardRef` and `cva` for variants; `'use client'` at the top when it uses hooks or Radix client primitives.
6. **Export** it from `src/index.ts` and add any new dependency to `packages/ui/package.json`.
7. **Shared CSS** goes in `src/styles.css` inside `@layer components` or `@layer utilities`.
8. **App side.** If the component needs i18n, routing or data hooks, add a thin adapter in `apps/web` (below). If it does not, import from `@open-gateway/ui` directly or add a one-line re-export in `apps/web/src/components/ui/`.
9. Run `pnpm --filter @open-gateway/ui typecheck` and `lint` before committing.

Caveat: `components.json` has aliases `ui: "@ui/components/ui"` and `css: "../../apps/web/src/styles/globals.css"`, but there is no `packages/ui/src/components/ui/` directory and components sit flat in `src/components/`. Running `shadcn add` would probably write into `src/components/ui/` (unverified). Move the result and fix its imports to match the flat layout.

## 3. `@open-gateway/config` (`packages/config`)

Private, source-only config package. No build. `package.json` `exports`:
| Export | File | Contents |
|---|---|---|
| `./eslint/base` | `eslint/base.js` | Flat config array: ignores, `js` recommended, `typescript-eslint` strict and stylistic type-checked, and rules similar to the root minus the React/Next/portal parts. |
| `./prettier/base` | `prettier/base.js` | `semi`, `singleQuote`, `tabWidth 2`, `trailingComma all`, `printWidth 100`, `arrowParens always`, `endOfLine lf`. |
| `./tailwind/base` | `tailwind/base.js` | A Tailwind v3-style config object mapping `primary` (DEFAULT/dark/light), `secondary`, `success`, `warning`, `danger` to `var(--color-*)`, and a `sans` font stack. |
| `./tsconfig/base`, `./tsconfig/base.json` | `tsconfig/base.json` | ES2022, strict, `noUncheckedIndexedAccess`, bundler resolution, `declaration` and source maps. |

Who uses which:
- **tsconfig**: `packages/ui/tsconfig.json` and `packages/types/tsconfig.json` extend `@open-gateway/config/tsconfig/base.json`. `packages/database/tsconfig.json` does not extend it.
- **tailwind**: `apps/web/tailwind.config.ts` imports `@open-gateway/config/tailwind/base`. Whether Tailwind v4 loads that file (globals.css has no `@config`) is unverified.
- **eslint and prettier**: I found no importer. The root `eslint.config.js` and `.prettierrc` are standalone copies. Unverified whether anything references the bases, for example other apps' configs.

## 4. `@open-gateway/types` (`packages/types`)

Zod plus shared TypeScript types. Built with tsup (cjs + esm + dts) to `dist/`. Depends on `zod ^3.25.76`.

**Important: only `src/index.ts` is built and exported.** The build is `tsup src/index.ts`, and `index.ts` does not re-export the other files. So `api.ts`, `auth.ts`, `common.ts` and `tenant.ts` are not in the package entry unless imported some other way (unverified whether any consumer deep-imports them).

`src/index.ts` exports:
- `PaginationSchema` (zod: `page` coerced int >=1, default 1; `pageSize` 1 to 100, default 20) and `PaginationInput`.
- Interfaces `PaginatedResponse<T>` (meta: `page`, `pageSize`, `totalCount`, `totalPages`), `ApiResponse<T>` (`{success:true,data,meta?}`) and `ApiErrorResponse` (`{success:false,error:{code,message,details?,traceId?}}`).
- Runtime enums (`UserStatus`, `TenantStatus`, `TenantPlan`, `ApiStatus`, `ApiKeyStatus`, `ApiSyncStatus`, `ApiHealthStatus`, `AuditAction`), all with string values equal to their names. **They are older and smaller than the Prisma enums.** For example `ApiStatus` lacks `RETIRED`. `AuditAction` lacks `ASSIGNED`, `ROTATED` and others. `UserStatus` and `TenantStatus` here match the Prisma values. Treat Prisma as the source of truth.

Unexported files (define overlapping, different shapes):
- `api.ts`: `ApiError`, `ApiSuccessResponse`, `ApiErrorResponse`, `PaginatedResponse` (a different meta shape: `limit`, `total`, `hasNextPage` and so on), `PaginatedQuery`, `SortDirection`, `SortField`.
- `auth.ts`: `UserRole`, `UserStatus` (lowercase string union), `User`, `LoginRequest/Response`, `RefreshToken*`, `Session`.
- `common.ts`: `BaseEntity`, `Timestamps`, `SoftDelete`, `PaginationParams`, `SortParams`, `FilterParams`, `Result/Ok/Err`, `Nullable`, `DeepPartial`, `RequireAtLeastOne`, `RequireExactlyOne`.
- `tenant.ts`: `TenantStatus` (lowercase union), `TenantConfig`, `TenantSubscription`, `Tenant`.

Consumers: `apps/api` and `apps/web` depend on it (`package.json`). Which symbols they import was not checked.

## 5. `@open-gateway/database` (`packages/database`)

Prisma 6 client for Postgres (`datasource db` uses `env("DATABASE_URL")`, generator `prisma-client-js`). Built with tsup to `dist/`. Depended on by `apps/api` and `apps/web`.

### Source (`src/`)
- `index.ts` exports `Prisma`, `PrismaClient`, the `prisma` singleton and `tykOrgIdFor(tenantId)` = `` `og-${tenantId}` ``. That value is stored once in `Tenant.tykOrgId` and never recomputed. It also re-exports these model and enum **types** only: `User`, `Tenant`, `UserTenant`, `Role`, `Permission`, `RolePermission`, `ApiDefinition`, `ApiKey`, `Quota`, `AuditLog`, and the enums `UserStatus`, `TenantStatus`, `TenantPlan`, `ApiStatus`, `ApiSyncStatus`, `ApiHealthStatus`, `ApiAuthType`, `ApiDefFormat`, `ApiKeyStatus`, `QuotaPeriod`, `AuditAction`. Models and enums added later (`McpServer`, `Plan`, `Product`, `Developer`, `Subscription`, `ApiProtocol`, `SpecCandidateState` and others) are not re-exported by name. They are reachable through `Prisma`/`@prisma/client` directly.
- `prisma.ts`: singleton `PrismaClient` cached on `globalThis` outside production. Logging is `['warn','error']` in development and `['error']` otherwise. It registers `SIGINT`, `SIGTERM` and `beforeExit` handlers that call `$disconnect()` and then `process.exit(0)`.

### Scripts
`db:generate` (`prisma generate`), `db:migrate` (`prisma migrate deploy`), `db:migrate:dev` (`prisma migrate dev`), `db:seed` (`tsx prisma/seed.ts`), `db:studio`, `test`, `typecheck`, `build`, `dev`, `clean`. `test` = `tsx prisma/permissions.check.ts && tsx scripts/migrate-users-to-kratos.check.ts`. No test framework, just `assert`. Prisma `seed` is also set to `tsx prisma/seed.ts`.

### Enums (`prisma/schema.prisma`)
| Enum | Values | Purpose |
|---|---|---|
| `UserStatus` | ACTIVE, INACTIVE, SUSPENDED | Dashboard user state |
| `TenantStatus` | ACTIVE, SUSPENDED, ARCHIVED | Tenant state |
| `TenantPlan` | FREE, STARTER, PRO, ENTERPRISE | Tenant's commercial tier label |
| `ApiStatus` | DRAFT, ACTIVE, DISABLED, RETIRED | API lifecycle. RETIRED = a sunset non-default version (WP16). Also used by `McpServer.status`. |
| `ApiSyncStatus` | PENDING, SYNCED, FAILED | Whether the last push to the gateway succeeded |
| `ApiHealthStatus` | HEALTHY, DEGRADED, DOWN, UNKNOWN | Upstream health |
| `ApiAuthType` | NONE, AUTH_TOKEN, JWT, OAUTH, HMAC, BASIC | How callers authenticate (HMAC and BASIC added in WP15c) |
| `ApiKeyStatus` | ACTIVE, REVOKED, EXPIRED | Key lifecycle |
| `QuotaPeriod` | HOURLY, DAILY, WEEKLY, MONTHLY | Quota and plan window |
| `ApiDefFormat` | CLASSIC, OAS | How the API is expressed on the gateway. The DB default is OAS, but pre-WP13b rows were stamped CLASSIC. |
| `ApiProtocol` | HTTP, TCP | TCP = raw L4 passthrough on its own port (WP27). CLASSIC format only. |
| `DeveloperStatus` | ACTIVE, SUSPENDED | Portal developer state (WP22) |
| `SubscriptionStatus` | PENDING, APPROVED, REVOKED | Portal subscription lifecycle. PENDING has no key. |
| `AuditAction` | CREATED, UPDATED, DELETED, REVOKED, ASSIGNED, UNASSIGNED, LOGIN, LOGOUT, ROLE_CHANGED, PERMISSION_GRANTED, PERMISSION_REVOKED, QUOTA_EXCEEDED, SYNC_SUCCEEDED, SYNC_FAILED, ROTATED, USAGE_RESET, QUOTA_UPDATED, QUOTA_RESET, ORG_UPDATED, ORG_RESET, KEY_RESET, SPEC_UPDATE_DETECTED | Audit event kinds. The `@Audit()` suffix maps to these (per migration `20261001000000`). |
| `SpecCandidateState` | PENDING, APPLIED, DISMISSED, SUPERSEDED | State of a watched-URL spec candidate (OAS-08) |
| `WebhookDeliveryStatus` | SUCCESS, FAILED | Webhook delivery outcome (WP27) |

### Models
Table names are given in `@@map`. Columns are snake_case via `@map`. Ids are uuid strings unless noted.

**Identity and access**
- `User` (`users`): dashboard user. Has `email` (unique), `name`, nullable `password` (Kratos is now the credential store), `status`, nullable unique `kratosIdentityId`. Relations: `userTenants`, `apiKeys`, `auditLogs`.
- `Tenant` (`tenants`): unique `slug`, unique `tykOrgId` (the Tyk organisation, `og-<id>`), `status`, `plan`, `config` JSON. It is the root of tenant scoping. It has children `UserTenant`, `ApiDefinition`, `ApiKey`, `Role`, `AuditLog`, `Plan`, `Product`, `Developer`, `WebhookSubscription`, `McpServer`, `ApiSpec`, `ApiSpecSource` and `SpecCandidate`.
- `UserTenant` (`user_tenants`): membership join with composite PK (`userId`, `tenantId`), a `role` string (default `viewer`) and `isDefault`. Cascades from both sides.
- `Role` (`roles`): per-tenant role, unique on (`name`, `tenantId`). Has many `RolePermission`.
- `Permission` (`permissions`): global catalog entry (`name`, `resource`, `action`), unique on (`resource`, `action`).
- `RolePermission` (`role_permissions`): Role to Permission join, composite PK, cascades from both.

**Gateway APIs and keys**
- `ApiDefinition` (`api_definitions`): a tenant's API as pushed to Tyk. Key fields:
  - `tykApiId`, `proxyUrl`, `listenPath`, `authType`, `status`, `config` JSON.
  - `syncStatus`, `syncError`, `syncState` JSON (per-node view from ReconcileService), `lastSyncedAt`, `healthStatus`.
  - `defFormat` and `oasDocument` (the generated OAS pushed to the gateway).
  - `adoptedFromGateway` JSON (WP25: the raw definition adopted from a node).
  - Versioning: `parentApiId` (self relation "ApiVersions", `onDelete: Restrict`), `versionName`, `retiredAt`.
  - `protocol`, `listenPort` (TCP), `webhooksEnabled`.
  - Unique on (`tenantId`, `slug`), (`tenantId`, `listenPath`) and (`parentApiId`, `versionName`).
  - Relations: `tenant`, `apiKeys`, `products` (`ProductApi`), `versions`, `webhookSubscriptions`, `mcpServers`, `specs`, `specSource`, `specCandidates`.
- `ApiKey` (`api_keys`): a Tyk key record. Has `tykKeyId`, `keyHash`, `status`, `expiresAt`, and optional links to `Plan` (`planId`, SetNull), `ApiDefinition` (`apiDefId`, SetNull) and `McpServer` (`mcpServerId`, SetNull). `tykAclPolicyId` is the per-key ACL policy paired with an ACL-less plan policy. Belongs to a `User` and a `Tenant` (both cascade). Has many `Quota`.
- `Quota` (`quotas`): per-key counter with `limit`, `used`, `period` and `resetAt`. Cascades from `ApiKey`.
- `McpServer` (`mcp_servers`): a REST-as-MCP proxy paired to one OAS-format `ApiDefinition` through `sourceApiId` (`onDelete: Restrict`). Has `listenPath`, `tools` JSON (array of tool DTOs), unique `tykApiId`, `status` and sync fields. Unique on (`tenantId`, `slug`) and (`tenantId`, `listenPath`).

**OpenAPI spec tracking**
- `ApiSpec` (`api_specs`): an immutable imported OpenAPI document version. Has `versionNo` (unique per API), `contentHash`, `format`, `openapiVersion`, verbatim `sourceText`, precomputed `endpointIndex` JSON and `endpointCount`. Not the same as `ApiDefinition.oasDocument`.
- `ApiSpecSource` (`api_spec_sources`): at most one per API (unique `apiDefId`). A watched spec URL with `enabled`, `intervalMinutes`, `nextCheckAt`, result and error codes, `etag`, `lastModified` and `consecutiveFailures`.
- `SpecCandidate` (`spec_candidates`): a document served by the watched URL that differs from the applied version. Has `state`, `diffSummary` and `findings` JSON, and `sourceText` kept only while PENDING.

**Commercial and portal**
- `Plan` (`plans`): a Tyk policy (its `id` is the policy id). Has `rate`/`per`, `quotaMax` (-1 = unlimited), `quotaPeriod`, `active`, `requiresApproval`. Unique (`tenantId`, `name`). `apiKeys` uses SetNull; `subscriptions` uses Restrict.
- `Product` (`products`): grouping of APIs, control-plane only. Unique (`tenantId`, `slug`) and (`tenantId`, `name`). Has `apis` (`ProductApi`) and `subscriptions` (Restrict).
- `ProductApi` (`product_apis`): Product to ApiDefinition join, composite PK, cascades from both.
- `Developer` (`developers`): portal identity, separate from `User`. Has `tenantId`, `email`, `name`, unique `kratosIdentityId`, `status`. Unique (`tenantId`, `email`). Has many `Application`.
- `Application` (`applications`): a developer's registered app. Unique (`developerId`, `name`). Cascades from `Developer`. Has many `Subscription`.
- `Subscription` (`subscriptions`): an Application's grant to a Product at a Plan tier, and the thing that issues a Tyk key (`tykKeyId`, `keyHash`, `tykAclPolicyId`). Has `status`, `approvedAt` and `revokedAt`. Unique (`applicationId`, `productId`). `product` and `plan` are `Restrict`; `application` cascades.

**Audit and webhooks**
- `AuditLog` (`audit_logs`): the only model with a `BigInt` autoincrement id. Has nullable `tenantId` and `userId` (both SetNull), `action`, `resource`, `details` JSON, `ipAddress`, `corrId` (mapped to `correlation_id`), and indexes by tenant/user + `createdAt` desc.
- `WebhookSubscription` (`webhook_subscriptions`): a tenant's receiver for one API's Tyk events. Has `receiverUrl` and an HMAC signing `secret` (returned once). Cascades from `Tenant` and `ApiDefinition`.
- `WebhookDelivery` (`webhook_deliveries`): the final outcome of a relay attempt set, with `attempts`, `status`, `responseStatus` and `error`. Cascades from `WebhookSubscription`.

### Tables not in Prisma
`tyk_analytics` and `tyk_aggregated` are created by Tyk Pump. They are deliberately **not modeled**. The tail comment in `schema.prisma` gives the reason: `prisma migrate diff` emits `CREATE TABLE` for them even with `@@ignore`, which would then fail `migrate deploy` wherever Pump already created them.
- They are read with `$queryRaw` and `to_regclass` presence checks in `apps/api/src/modules/analytics/services/pump-query.builder.ts`.
- Consequence: a bare `prisma migrate dev` will see them as drift and offer a reset. Never accept that (see the global no-reset rule). Use `prisma migrate dev --create-only`, hand-edit the SQL, then `prisma migrate deploy`.
- See also `docs/ANALYTICS-PIPELINE.md`.

### Migrations (`prisma/migrations/`)
- `migration_lock.toml`: provider `postgresql`.
- 19 directories named `YYYYMMDDHHMMSS_name`, applied in lexicographic order. They run from `20260918000000_init` to `20261003000000_spec_sources`.
- Most later ones are hand-written and idempotent (`IF NOT EXISTS`, `ADD VALUE`), with header comments naming their work-package. Two pairs share a date prefix (`20260926000000_*` and `20260929000000_*`) and rely on distinct suffixes for order.
- `.prettierignore` excludes this directory from formatting.
- Apply with `pnpm db:migrate` (`prisma migrate deploy`). Dev with `pnpm db:migrate:dev`.

### Seeds and scripts
- `prisma/permissions.ts`: exports `PERMISSIONS`, the catalog (38 entries per the count in `permissions.check.ts`, with names like `api:read` and `key:revoke`).
- `prisma/permissions.check.ts`: the tripwire test. The seeded catalog must equal an explicit list.
- `prisma/seed.ts`: imports `PERMISSIONS` and `tykOrgIdFor`, and uses `bcrypt`. It defines roles `super_admin` (all permissions), `admin` (all except `tenant:delete` and `role:delete`), `operator` (an explicit list) and `viewer` (all `read` and `export` actions). It also mentions a hand-synced mapping to Keto relations. I read only the first ~60 lines; what else it seeds (tenants, users) is unverified.
- `scripts/` (run with `tsx`; not part of the build):
  - `migrate-users-to-kratos.ts`: idempotent import of `User` rows into Ory Kratos, keeping bcrypt hashes. `migration-candidate.ts` holds the row filter. `migrate-users-to-kratos.check.ts` pins that filter.
  - `wp12c-tenant-org-cutover.ts`: one-shot move from the shared Tyk org to per-tenant orgs.
  - `wp12c-acceptance.ts`, `wp13a-acceptance.ts`, `wp13b-acceptance.ts`, `wp15a-acceptance.ts`, `wp15b-acceptance.ts` and `wp15c-acceptance.ts`: acceptance checks against a live gateway and DB.
