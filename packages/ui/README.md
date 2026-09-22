# @open-gateway/ui

Shared UI component library built with [shadcn/ui](https://ui.shadcn.com/), Radix UI primitives, and Tailwind CSS.

## Usage

Components from this package can be imported directly in apps:

```tsx
import { Button } from '@open-gateway/ui/components/ui/button';
```

## Adding New Components

Use the shadcn CLI to add new components:

```bash
cd packages/ui
pnpm dlx shadcn@latest add button
```

Components will be added to `src/components/ui/` and automatically available for use across all apps.

## Design Tokens

Design tokens (colors, spacing, typography) are defined in the app's global CSS and Tailwind config. This package imports styles from `apps/web/src/styles/globals.css`.

## Architecture

- **Components**: Atomic UI primitives and composite components
- **Hooks**: Shared React hooks for UI logic
- **Lib**: Utility functions (cn, formatters, etc.)

## Dependencies

- Radix UI for accessible primitives
- class-variance-authority for component variants
- lucide-react for icons
- tailwind-merge + clsx for className composition
