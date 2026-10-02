'use client';

import { formatDistanceToNow } from 'date-fns';
import { Activity, AlertTriangle, Clock, Database, Gauge, Timer, Users, Zap } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Figure } from '@/components/dashboard/figure';
import { KpiTile, KpiTileSkeleton } from '@/components/dashboard/kpi-tile';
import { useFormat } from '@/hooks/use-format';
import { dateFnsLocale } from '@/lib/date-fns-locale';
import { searchToken } from '@/lib/traffic-filters-to-query';
import type { Locale } from '@/i18n/locales';
import type { AnalyticsTraffic, TrafficFilters } from '@/types';

/** Error-rate thresholds for the tile colour: over 1% is worth a look, over 5% is an incident. */
const ERROR_WARN = 1;
const ERROR_BAD = 5;

/**
 * Eight headline figures for the filtered traffic; rates and latencies show a dash without traffic.
 * Each opens the requests behind it (`searchHref`: the page's filters plus what the figure is about,
 * undefined when the user cannot open search, which leaves the tiles plain).
 */
export function TrafficKpis({
  data,
  searchHref,
}: {
  data: AnalyticsTraffic | undefined;
  searchHref?: (override?: Partial<TrafficFilters>, extra?: readonly (string | null)[]) => string | undefined;
}) {
  const t = useTranslations('analytics.traffic.kpis');
  const fmt = useFormat();
  const locale = useLocale();
  const dfLocale = dateFnsLocale(locale as Locale);

  if (!data) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-busy="true">
        {Array.from({ length: 8 }).map((_, i) => (
          <KpiTileSkeleton key={i} />
        ))}
      </div>
    );
  }

  const s = data.summary;
  const has = s.requests > 0;
  const perSecond = new Intl.NumberFormat(locale, {
    maximumFractionDigits: s.requestsPerSecond < 10 ? 2 : 0,
  });
  const requests = searchHref?.();
  // Errors are counted as status 400 and up (the API's own definition).
  const failed = searchHref?.({}, ['status:>=400']);
  // The slow tail: the requests at or above the percentile the tile reports.
  const atLeast = (ms: number) =>
    has && ms >= 1 ? searchHref?.({}, [searchToken('latency', `>=${String(Math.floor(ms))}`)]) : undefined;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <KpiTile
        icon={Activity}
        label={t('requests')}
        value={<Figure value={s.requests} kind="compact" />}
        hint={
          s.lastRequestAt
            ? t('lastRequest', {
                // Never later than now: a clock a little ahead would otherwise read "in less than a minute".
                when: formatDistanceToNow(new Date(Math.min(Date.parse(s.lastRequestAt), Date.now())), {
                  addSuffix: true,
                  locale: dfLocale,
                }),
              })
            : t('noRequests')
        }
        href={requests}
      />
      <KpiTile
        icon={Zap}
        label={t('throughput')}
        value={has ? perSecond.format(s.requestsPerSecond) : '—'}
        hint={t('perSecond')}
        href={requests}
      />
      <KpiTile
        icon={AlertTriangle}
        label={t('errorRate')}
        tone={
          !has
            ? 'default'
            : s.errorRate >= ERROR_BAD
              ? 'bad'
              : s.errorRate >= ERROR_WARN
                ? 'warn'
                : 'good'
        }
        value={has ? <Figure value={s.errorRate} kind="percent" /> : '—'}
        hint={t('errorSplit', {
          client: fmt.number(s.clientErrors),
          server: fmt.number(s.serverErrors),
        })}
        href={failed}
      />
      <KpiTile
        icon={Clock}
        label={t('avgLatency')}
        value={has ? <Figure value={s.avgLatencyMs} kind="ms" /> : '—'}
        hint={has ? t('upstream', { value: fmt.ms(s.avgUpstreamLatencyMs) }) : undefined}
        href={requests}
      />
      <KpiTile
        icon={Gauge}
        label={t('p95')}
        value={has ? <Figure value={s.p95LatencyMs} kind="ms" /> : '—'}
        hint={has ? t('p50', { value: fmt.ms(s.p50LatencyMs) }) : undefined}
        href={atLeast(s.p95LatencyMs)}
      />
      <KpiTile
        icon={Timer}
        label={t('p99')}
        value={has ? <Figure value={s.p99LatencyMs} kind="ms" /> : '—'}
        hint={t('slowestOnePercent')}
        href={atLeast(s.p99LatencyMs)}
      />
      <KpiTile
        icon={Users}
        label={t('clients')}
        value={<Figure value={s.uniqueClients} kind="compact" />}
        hint={t('clientsHint', {
          keys: fmt.number(s.uniqueKeys),
          share: fmt.percent(s.anonymousShare),
        })}
        href={requests}
      />
      <KpiTile
        icon={Database}
        label={t('dataIn')}
        value={fmt.bytes(s.bytesIn)}
        hint={t('dataInHint')}
        href={requests}
      />
    </div>
  );
}
