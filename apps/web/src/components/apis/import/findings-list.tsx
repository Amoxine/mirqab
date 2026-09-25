import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import type { LintFinding } from '@/lib/api/openapi';

const SHOWN = 50;

/**
 * Lint findings as the API returned them: errors first (they block), then warnings with their line.
 * Rule ids, JSON paths and messages come from the linter and are not translated.
 */
export function FindingsList({ findings }: { findings: readonly LintFinding[] }) {
  const t = useTranslations('openapi');
  const errors = findings.filter((f) => f.severity === 'error');
  const others = findings.filter((f) => f.severity !== 'error');
  if (findings.length === 0) return <p className="text-sm text-muted-foreground">{t('findings.none')}</p>;
  const sorted = [...errors, ...others];
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium" role={errors.length ? 'alert' : undefined}>
        {errors.length
          ? t('findings.errors', { errors: errors.length, warnings: others.length })
          : t('findings.warningsOnly', { warnings: others.length })}
      </p>
      <ul className="max-h-64 space-y-2 overflow-y-auto">
        {sorted.slice(0, SHOWN).map((f, i) => (
          <li key={`${f.code}-${String(f.line)}-${String(i)}`} className="rounded-md border p-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={f.severity === 'error' ? 'destructive' : 'warning'}>{t(`findings.severity.${f.severity}`)}</Badge>
              <span className="text-xs text-muted-foreground">{t('findings.line', { line: f.line })}</span>
              <span dir="ltr" className="font-mono text-xs">
                {f.code}
              </span>
            </div>
            <p dir="ltr" className="mt-1 break-words">
              {f.message}
            </p>
            {f.path && (
              <p dir="ltr" className="break-all font-mono text-xs text-muted-foreground">
                {f.path}
              </p>
            )}
          </li>
        ))}
      </ul>
      {sorted.length > SHOWN && <p className="text-sm text-muted-foreground">{t('findings.more', { count: sorted.length - SHOWN })}</p>}
    </div>
  );
}
