import { AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

/** Shared by every `(auth)/auth/*` page for "the flow itself could not be started/loaded" —
 * distinct from `KratosFlowForm`'s own in-form validation messages. */
export function AuthErrorCard({ message }: { message: string }) {
  return (
    <Card className="w-full max-w-md border-border/50 shadow-lg">
      <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
        <AlertTriangle className="h-8 w-8 text-destructive" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">{message}</p>
      </CardContent>
    </Card>
  );
}
