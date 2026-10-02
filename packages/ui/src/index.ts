// Shared UI: the design system's round buttons, cards (incl. the dark "ink" chart surface),
// tables and the world map. Theme tokens and `styles.css` come from the consuming app.
export { cn } from './lib/utils';
export { Button, buttonVariants, type ButtonProps } from './components/button';
export {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  cardVariants,
  type CardProps,
} from './components/card';
export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from './components/table';
export { WorldMap, isOnMap, projectToMap, type WorldMapNode } from './components/world-map';
export { Progress } from './components/progress';
export { ToggleGroup, ToggleGroupItem } from './components/toggle-group';
export * from './components/badge';
export * from './components/skeleton';
export * from './components/input';
export * from './components/textarea';
export * from './components/label';
export * from './components/switch';
export * from './components/checkbox';
export * from './components/select';
export * from './components/dialog';
export * from './components/sheet';
export * from './components/dropdown-menu';
export * from './components/tooltip';
export * from './components/tabs';
export * from './components/alert-dialog';
export * from './components/popover';
export * from './components/chip-input';
export * from './components/page-filter';
export * from './components/segmented-control';
export * from './components/state-card';
export * from './components/page-header';
export * from './components/eyebrow';
export * from './components/kpi-tile';
export * from './components/notice';
export * from './components/share-list';
export * from './components/sparkline';
export * from './lib/viz';
export * from './components/confirm-dialog';
export * from './components/copy-button';
export * from './components/secret-field';
export * from './components/reveal-dialog';
export * from './components/data-table';
export * from './components/row-link';
export { useMediaQuery } from './lib/use-media-query';
export * from './components/error-state';
export * from './components/chart-card';
export * from './components/method-badge';
export * from './components/figure';
export * from './components/status-badge';
