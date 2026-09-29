'use client';

import { Notice } from '@open-gateway/ui';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { MethodBadge } from '@/components/apis/endpoints/method-badge';
import { FindingsList } from '@/components/apis/import/findings-list';
import { Badge } from '@/components/ui/badge';
import type { EndpointRow, SpecUpdateResult } from '@/lib/api/openapi';

const SHOWN = 50;

function RowList({ title, rows, extra }: { title: string; rows: EndpointRow[]; extra?: (row: EndpointRow) => string }) {
  const t = useTranslations('openapi');
  if (rows.length === 0) return null;
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium">{title}</h4>
      <ul className="max-h-56 space-y-1 overflow-y-auto">
        {rows.slice(0, SHOWN).map((r) => (
          <li key={r.key} className="flex flex-wrap items-center gap-2 text-sm">
            <MethodBadge method={r.method} />
            <span dir="ltr" className="break-all font-mono text-xs">{r.path}</span>
            {extra && <span className="text-xs text-muted-foreground">{extra(r)}</span>}
          </li>
        ))}
      </ul>
      {rows.length > SHOWN && <p className="text-sm text-muted-foreground">{t('findings.more', { count: rows.length - SHOWN })}</p>}
    </div>
  );
}

/**
 * The OAS-04 dry-run result: added / removed / changed endpoints, which governed endpoints it
 * affects, and findings. Shared by the upload Sheet and the OAS-08 review of a detected version;
 * `acknowledge` is the caller's form control, shown inside the removed-governed warning.
 */
export function SpecDiffView({ result: r, acknowledge }: { result: SpecUpdateResult; acknowledge?: ReactNode }) {
  const t = useTranslations('openapi');
  const removedGoverned = r.governanceImpact.removedGoverned;
  return (
    <section aria-labelledby="spec-diff" className="space-y-4">
      <h3 id="spec-diff" className="text-sm font-medium" role="status">
        {r.unchanged
          ? t('specUpdate.unchanged')
          : t('specUpdate.summary', { added: r.diff.added.length, removed: r.diff.removed.length, changed: r.diff.changed.length })}
      </h3>
      <FindingsList findings={r.findings} />
      <RowList title={t('specUpdate.added')} rows={r.diff.added} />
      <RowList title={t('specUpdate.removed')} rows={r.diff.removed} />
      <RowList
        title={t('specUpdate.changed')}
        rows={r.diff.changed.map((c) => c.after)}
        extra={(row) => {
          const fields = r.diff.changed.find((c) => c.key === row.key)?.fields ?? [];
          return t('specUpdate.changedFields', { fields: fields.join(', ') });
        }}
      />
      {r.governanceImpact.changedGoverned.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-sm font-medium">{t('specUpdate.changedGoverned')}</h4>
          <div className="flex flex-wrap gap-1">
            {r.governanceImpact.changedGoverned.map((key) => (
              <Badge key={key} variant="outline" dir="ltr" className="font-mono font-normal">
                {key}
              </Badge>
            ))}
          </div>
        </div>
      )}
      {removedGoverned.length > 0 && (
        <Notice>
          <p>{t('specUpdate.removedGoverned', { count: removedGoverned.length })}</p>
          <ul className="space-y-0.5">
            {removedGoverned.map((g) => (
              <li key={g.key} dir="ltr" className="break-all font-mono text-xs">
                {g.key}
              </li>
            ))}
          </ul>
          {acknowledge}
        </Notice>
      )}
    </section>
  );
}
