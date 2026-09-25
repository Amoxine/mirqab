'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Pencil } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { ApiConfig } from '@/types';

interface ApiConfigCardProps {
  config: ApiConfig | null;
  /** Opens the edit sheet. Omit to hide the Edit button (caller lacks `api:update`). */
  onEdit?: () => void;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[11rem_1fr] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

// `items` is optional so a partially stored CORS object (created straight through the API) cannot crash the page.
function Chips({ items = [] }: { items?: string[] }) {
  const t = useTranslations('apis');
  if (items.length === 0) return <span className="text-muted-foreground">{t('config.none')}</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => (
        <Badge key={item} variant="secondary" className="max-w-full break-all font-mono font-normal">
          {item}
        </Badge>
      ))}
    </div>
  );
}

/** Read-only view of an API's `config` (rate limit, CORS, do-not-track). */
export function ApiConfigCard({ config, onEdit }: ApiConfigCardProps) {
  const t = useTranslations('apis');
  const tCommon = useTranslations('common');
  const rateLimit = config?.rateLimit;
  const cors = config?.cors;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-lg">{t('tabs.configuration')}</CardTitle>
        {onEdit && (
          <Button type="button" variant="outline" size="sm" onClick={onEdit}>
            <Pencil className="h-4 w-4" />
            {tCommon('edit')}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <dl className="space-y-4">
          <Row label={t('config.rateLimit')}>
            {rateLimit && rateLimit.rate > 0
              ? t('config.rateLimitValue', { rate: rateLimit.rate, per: rateLimit.per })
              : t('config.unlimited')}
          </Row>
          <Row label={t('config.cors')}>
            {cors?.enable ? <Badge>{t('config.enabled')}</Badge> : <Badge variant="outline">{t('config.disabled')}</Badge>}
          </Row>
          {cors?.enable && (
            <>
              <Row label={t('config.allowedOrigins')}>
                <Chips items={cors.allowedOrigins} />
              </Row>
              <Row label={t('config.allowedMethods')}>
                <Chips items={cors.allowedMethods} />
              </Row>
              <Row label={t('config.allowedHeaders')}>
                <Chips items={cors.allowedHeaders} />
              </Row>
              <Row label={t('config.exposedHeaders')}>
                <Chips items={cors.exposedHeaders} />
              </Row>
              <Row label={t('config.credentials')}>{cors.allowCredentials ? t('config.allowed') : t('config.notAllowed')}</Row>
              <Row label={t('config.maxAge')}>{t('config.maxAgeValue', { seconds: cors.maxAge })}</Row>
            </>
          )}
          <Row label={t('config.doNotTrack')}>
            {config?.doNotTrack ? (
              <Badge>{t('config.on')}</Badge>
            ) : (
              <Badge variant="outline">{t('config.off')}</Badge>
            )}
            <span className="ms-2 text-muted-foreground">
              {config?.doNotTrack ? t('config.trackingOff') : t('config.trackingOn')}
            </span>
          </Row>
        </dl>
      </CardContent>
    </Card>
  );
}
