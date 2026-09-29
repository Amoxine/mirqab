import { Badge } from '@/components/ui/badge';

/** Names the API a dashboard card is narrowed to, in the card's header. Renders nothing for the gateway-wide view. */
export function ScopeTag({ name }: { name?: string }) {
  if (!name) return null;
  return (
    <Badge variant="outline" dir="auto" className="max-w-[12rem] truncate font-mono text-[0.68rem]">
      {name}
    </Badge>
  );
}
