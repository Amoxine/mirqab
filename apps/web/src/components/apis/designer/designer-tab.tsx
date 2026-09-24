'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { FlaskConical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PermissionGate } from '@/components/auth/permission-gate';
import { usePermissions } from '@/hooks/use-permissions';
import type { ApiDefinition } from '@/hooks/use-apis';
import { AuthenticationSheet } from './authentication-sheet';
import { BodyTransformSheet } from './body-transform-sheet';
import { DetailedRecordingSheet } from './detailed-recording-sheet';
import { EndpointList } from './endpoint-list';
import { HeaderTransformSheet } from './header-transform-sheet';
import { IpAccessSheet } from './ip-access-sheet';
import { LoadBalancingSheet } from './load-balancing-sheet';
import { MiddlewareCard } from './middleware-card';
import { MockResponseSheet } from './mock-response-sheet';
import { RequestValidationSheet } from './request-validation-sheet';
import { ResponseCacheSheet } from './response-cache-sheet';
import { TestRequestSheet } from './test-request-sheet';
import { TrafficLimitsSheet } from './traffic-limits-sheet';
import { UptimeTestsSheet } from './uptime-tests-sheet';
import { UrlRewriteSheet } from './url-rewrite-sheet';

// One entry per Designer Sheet. A plain union rather than 12 separate booleans, so at most one
// Sheet is ever open at a time and closing one is always "set to null".
type SheetName =
  | 'traffic'
  | 'loadBalancing'
  | 'uptimeTests'
  | 'headerTransform'
  | 'urlRewrite'
  | 'bodyTransform'
  | 'mock'
  | 'cache'
  | 'detailedRecording'
  | 'ipAccess'
  | 'requestValidation'
  | 'authentication'
  | 'testRequest';

interface DesignerTabProps {
  api: ApiDefinition;
}

/** WP17: every WP15a-c middleware, editable via its own RHF+Zod Sheet, plus the OAS-derived
 * endpoint list and the "Test request" action. */
export function DesignerTab({ api }: DesignerTabProps) {
  const t = useTranslations('apis');
  const tCommon = useTranslations('common');
  const { can } = usePermissions();
  const [openSheet, setOpenSheet] = useState<SheetName | null>(null);
  const canEdit = can('api:update');
  const config = api.config ?? {};
  const notConfigured = t('designer.summary.notConfigured');

  const close = () => {
    setOpenSheet(null);
  };
  const edit = (name: SheetName) => (canEdit ? () => { setOpenSheet(name); } : undefined);

  const trafficActive =
    (config.rateLimit?.rate ?? 0) > 0 ||
    (config.throttle?.retryLimit ?? 0) > 0 ||
    config.timeoutSeconds != null ||
    config.requestSizeLimitBytes != null ||
    !!config.circuitBreaker;
  const trafficSummary = config.rateLimit?.rate
    ? t('config.rateLimitValue', { rate: config.rateLimit.rate, per: config.rateLimit.per })
    : t('config.unlimited');

  const lbTargets = config.loadBalancing?.targets.length ?? 0;
  const uptimeCount = config.uptimeTests?.length ?? 0;
  const headersActive = !!(config.transformRequestHeaders ?? config.transformResponseHeaders);
  const bodyTransformActive = !!(config.transformRequestBody ?? config.transformResponseBody);
  const cacheActive = !!config.cache;
  const ipCount = (config.ipAccessControl?.allow?.length ?? 0) + (config.ipAccessControl?.block?.length ?? 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{t('designer.endpoints.title')}</h2>
        </div>
        <PermissionGate permission="api:update">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setOpenSheet('testRequest');
            }}
          >
            <FlaskConical className="me-2 h-4 w-4" />
            {t('designer.testRequest.title')}
          </Button>
        </PermissionGate>
      </div>
      <EndpointList oasDocument={api.oasDocument} />

      <div>
        <h2 className="mb-3 text-lg font-semibold">{t('designer.middleware.title')}</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <MiddlewareCard
            title={t('designer.traffic.title')}
            summary={trafficSummary}
            active={trafficActive}
            activeLabel={t('config.enabled')}
            inactiveLabel={t('config.unlimited')}
            editLabel={tCommon('edit')}
            onEdit={edit('traffic')}
          />
          <MiddlewareCard
            title={t('designer.loadBalancing.title')}
            summary={lbTargets > 0 ? t('designer.loadBalancing.summary', { count: lbTargets }) : notConfigured}
            active={lbTargets > 0}
            activeLabel={t('config.enabled')}
            inactiveLabel={t('config.disabled')}
            editLabel={tCommon('edit')}
            onEdit={edit('loadBalancing')}
          />
          <MiddlewareCard
            title={t('designer.uptimeTests.title')}
            summary={uptimeCount > 0 ? t('designer.uptimeTests.summary', { count: uptimeCount }) : notConfigured}
            active={uptimeCount > 0}
            activeLabel={t('config.enabled')}
            inactiveLabel={t('config.disabled')}
            editLabel={tCommon('edit')}
            onEdit={edit('uptimeTests')}
          />
          <MiddlewareCard
            title={t('designer.headerTransform.title')}
            summary={headersActive ? t('config.enabled') : notConfigured}
            active={headersActive}
            activeLabel={t('config.enabled')}
            inactiveLabel={t('config.disabled')}
            editLabel={tCommon('edit')}
            onEdit={edit('headerTransform')}
          />
          <MiddlewareCard
            title={t('designer.urlRewrite.title')}
            summary={config.urlRewrite ? `${config.urlRewrite.pattern} → ${config.urlRewrite.rewriteTo}` : notConfigured}
            active={!!config.urlRewrite}
            activeLabel={t('config.enabled')}
            inactiveLabel={t('config.disabled')}
            editLabel={tCommon('edit')}
            onEdit={edit('urlRewrite')}
          />
          <MiddlewareCard
            title={t('designer.bodyTransform.title')}
            summary={bodyTransformActive ? t('config.enabled') : notConfigured}
            active={bodyTransformActive}
            activeLabel={t('config.enabled')}
            inactiveLabel={t('config.disabled')}
            editLabel={tCommon('edit')}
            onEdit={edit('bodyTransform')}
          />
          <MiddlewareCard
            title={t('designer.mock.title')}
            summary={config.mock ? t('designer.mock.summary', { code: config.mock.code }) : notConfigured}
            active={!!config.mock}
            activeLabel={t('config.enabled')}
            inactiveLabel={t('config.disabled')}
            editLabel={tCommon('edit')}
            onEdit={edit('mock')}
          />
          <MiddlewareCard
            title={t('designer.cache.title')}
            summary={cacheActive ? t('designer.cache.summary', { seconds: config.cache?.timeoutSeconds ?? 0 }) : notConfigured}
            active={cacheActive}
            activeLabel={t('config.enabled')}
            inactiveLabel={t('config.disabled')}
            editLabel={tCommon('edit')}
            onEdit={edit('cache')}
          />
          <MiddlewareCard
            title={t('designer.detailedRecording.title')}
            summary={config.detailedRecording ? t('config.on') : t('config.off')}
            active={!!config.detailedRecording}
            activeLabel={t('config.on')}
            inactiveLabel={t('config.off')}
            editLabel={tCommon('edit')}
            onEdit={edit('detailedRecording')}
          />
          <MiddlewareCard
            title={t('designer.ipAccess.title')}
            summary={ipCount > 0 ? t('designer.ipAccess.summary', { count: ipCount }) : notConfigured}
            active={ipCount > 0}
            activeLabel={t('config.enabled')}
            inactiveLabel={t('config.disabled')}
            editLabel={tCommon('edit')}
            onEdit={edit('ipAccess')}
          />
          <MiddlewareCard
            title={t('designer.requestValidation.title')}
            summary={config.validateRequestSchema ? t('config.enabled') : notConfigured}
            active={!!config.validateRequestSchema}
            activeLabel={t('config.enabled')}
            inactiveLabel={t('config.disabled')}
            editLabel={tCommon('edit')}
            onEdit={edit('requestValidation')}
          />
          <MiddlewareCard
            title={t('designer.authentication.title')}
            summary={t(`authTypes.${api.authType}`)}
            active={api.authType !== 'NONE'}
            activeLabel={t('config.enabled')}
            inactiveLabel={t('config.disabled')}
            editLabel={tCommon('edit')}
            onEdit={edit('authentication')}
          />
        </div>
      </div>

      <TrafficLimitsSheet api={api} open={openSheet === 'traffic'} onOpenChange={close} />
      <LoadBalancingSheet api={api} open={openSheet === 'loadBalancing'} onOpenChange={close} />
      <UptimeTestsSheet api={api} open={openSheet === 'uptimeTests'} onOpenChange={close} />
      <HeaderTransformSheet api={api} open={openSheet === 'headerTransform'} onOpenChange={close} />
      <UrlRewriteSheet api={api} open={openSheet === 'urlRewrite'} onOpenChange={close} />
      <BodyTransformSheet api={api} open={openSheet === 'bodyTransform'} onOpenChange={close} />
      <MockResponseSheet api={api} open={openSheet === 'mock'} onOpenChange={close} />
      <ResponseCacheSheet api={api} open={openSheet === 'cache'} onOpenChange={close} />
      <DetailedRecordingSheet api={api} open={openSheet === 'detailedRecording'} onOpenChange={close} />
      <IpAccessSheet api={api} open={openSheet === 'ipAccess'} onOpenChange={close} />
      <RequestValidationSheet api={api} open={openSheet === 'requestValidation'} onOpenChange={close} />
      <AuthenticationSheet api={api} open={openSheet === 'authentication'} onOpenChange={close} />
      <TestRequestSheet api={api} open={openSheet === 'testRequest'} onOpenChange={close} />
    </div>
  );
}
