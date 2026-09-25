import { useTranslations } from 'next-intl';
import type { EndpointCapability } from '@/lib/api/openapi';

/**
 * Controls the gateway accepts but that were not proven to be enforced on the pinned Tyk OSS, as the
 * API reports them. Listed (never offered) so an operator sees why a familiar control is missing.
 * The names are gateway field ids (not translated). The API's `behaviour` text is English, so it is
 * never shown: a translated description per known control is, and an unknown control gets none.
 */
export function UnavailableControls({ capabilities }: { capabilities: readonly EndpointCapability[] }) {
  const t = useTranslations('openapi');
  const unverified = capabilities.filter((c) => c.status === 'unverified');
  if (unverified.length === 0) return null;
  return (
    <details className="rounded-md border p-3 text-sm">
      <summary className="min-h-11 cursor-pointer content-center font-medium">
        {t('governance.unavailableTitle', { count: unverified.length })}
      </summary>
      <p className="mt-2 text-muted-foreground">{t('governance.unavailableHelp')}</p>
      <ul className="mt-2 space-y-2">
        {unverified.map((c) => (
          <li key={c.control} className="min-w-0">
            <span dir="ltr" className="font-mono text-xs">
              {c.control}
            </span>
            {t.has(`unverifiedControls.${c.control}`) && (
              <p className="break-words text-muted-foreground">{t(`unverifiedControls.${c.control}`)}</p>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
