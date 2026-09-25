import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

interface StatCardProps {
  title: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  description?: string;
}

/** KPI tile shared by the dashboard overview and the analytics page. */
export function StatCard({ title, value, icon: Icon, description }: StatCardProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
      </CardHeader>
      <CardContent>
        {/* tabular-nums: digits keep their width, so a refetch doesn't make the tile jitter. */}
        <div className="text-2xl font-bold tabular-nums">{value}</div>
        {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
      </CardContent>
    </Card>
  );
}

/** Same footprint as `StatCard`, so the grid doesn't shift when data arrives. */
export function StatCardSkeleton() {
  return (
    <Card aria-hidden="true">
      <CardHeader className="pb-2">
        <Skeleton className="h-4 w-24" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-8 w-20" />
        <Skeleton className="mt-2 h-3 w-32" />
      </CardContent>
    </Card>
  );
}
