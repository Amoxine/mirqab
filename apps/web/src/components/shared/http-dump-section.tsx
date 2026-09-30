import type { HttpDump } from '@/hooks/use-apis';

/**
 * One side of a captured request: its start line, headers, then its body. Shared by the per-API
 * traffic inspector and the traffic search detail, so the two show a capture the same way.
 * Text comes in as props (`empty`, `truncatedLabel`) because the two callers use different namespaces.
 */
export function HttpDumpSection({
  label,
  dump,
  empty,
  truncatedLabel,
}: {
  label: string;
  dump: HttpDump | null;
  empty: string;
  truncatedLabel: string;
}) {
  if (!dump) {
    return (
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">{label}</h3>
        <p className="text-muted-foreground text-xs">{empty}</p>
      </div>
    );
  }
  const entries = Object.entries(dump.headers);
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">{label}</h3>
      <p className="break-all font-mono text-xs" dir="ltr">
        {dump.startLine}
      </p>
      {entries.length > 0 && (
        <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs" dir="ltr">
          {entries.map(([name, value]) => (
            <div key={name} className="contents">
              <dt className="text-muted-foreground font-mono">{name}</dt>
              <dd className="min-w-0 break-all font-mono">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {dump.body && (
        <pre className="bg-muted max-h-40 overflow-auto rounded p-2 text-xs" dir="ltr">
          {dump.body}
        </pre>
      )}
      {dump.truncated && <p className="text-muted-foreground text-xs">{truncatedLabel}</p>}
    </div>
  );
}
