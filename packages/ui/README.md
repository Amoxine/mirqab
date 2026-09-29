# @open-gateway/ui

Shared React components for the MIRQAB dashboard, built on Radix UI primitives, class-variance-authority and Tailwind CSS v4. Consumed as **source** by `apps/web`: there is no build step, and `main`, `types` and `exports` point at `src/`.

Full reference (props, variants, rules): `docs/reference/packages.md`.

## Contents

Exported from `src/index.ts` (the only public entry):

- `cn`
- `Button`, `buttonVariants`
- `Card` (+ `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`, `cardVariants`), with variant `default` or `ink`
- `Table` (+ `TableHeader`, `TableBody`, `TableFooter`, `TableHead`, `TableRow`, `TableCell`, `TableCaption`)
- `Progress`
- `ToggleGroup`, `ToggleGroupItem`
- `WorldMap`, `WorldMapNode`, `projectToMap`, `isOnMap` (land mask in `src/components/world-map-data.ts`)

## Usage

```tsx
import { Button, Card, CardContent } from '@open-gateway/ui';

<Card variant="ink">
  <CardContent>
    <Button variant="outline" loading={pending}>Save</Button>
  </CardContent>
</Card>;
```

Inside `apps/web`, `src/components/ui/{button,card,table,progress,toggle-group}.tsx` re-export these, so `@/components/ui/button` also works.

## How `apps/web` wires it

- `apps/web/next.config.ts`: `transpilePackages: ['@open-gateway/ui', '@open-gateway/types']`.
- `apps/web/src/styles/globals.css` imports `packages/ui/src/styles.css` (`.surface-ink`, `.ui-pulse-ring`) and adds `@source '../../../../packages/ui/src'` so Tailwind scans this package for utility classes.

## Design tokens

The package defines no token values. Colours (`--color-primary`, `--color-card`, `--color-ink`, `--color-grid-dot` and so on) come from the `@theme` block in `apps/web/src/styles/globals.css`. Components use them through Tailwind utilities or `var(--color-*)`. `.surface-ink` in `src/styles.css` re-points the tokens inside dark "ink" cards.

## Adding a component

1. Start from the shadcn/ui component (new-york style); do not reinvent one that exists.
2. Create `src/components/<name>.tsx`. Import only relative paths (`../lib/utils`) and npm packages, never anything from `apps/web` or `@/`.
3. Use theme tokens, not hex values. Take text as props (no hardcoded strings).
4. Export it from `src/index.ts` and add new dependencies to this `package.json`.
5. Optionally add a re-export shim in `apps/web/src/components/ui/`.
6. Run `pnpm --filter @open-gateway/ui typecheck` and `lint`.

Note: `components.json` still points shadcn at `@ui/components/ui` and `apps/web/src/styles/globals.css`, but components here live flat in `src/components/`. If you use `shadcn add`, move the output and fix its imports.

## Scripts

`lint` (`eslint src/`), `typecheck` (`tsc --noEmit`), `clean`. There is no `build`; a `dist/` folder may exist locally but it is gitignored, stale and unused.

## Dependencies

Radix UI (`react-slot`, `react-progress`, `react-toggle-group` are the ones the sources import), `class-variance-authority`, `lucide-react`, `tailwind-merge` and `clsx`. Peers: `react` and `react-dom` 19.
