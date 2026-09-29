'use client';

import { useTranslations } from 'next-intl';
import { RevealDialog } from '@open-gateway/ui';
import { toast } from '@/components/ui/sonner';

/** Shows a freshly-minted subscription key exactly once — the same dialog as the dashboard's
 * `KeyCreatedDialog`: the key only ever exists in this one response, nothing stores it, and it is
 * never fetched again. */
export function KeyRevealDialog({
  keyValue,
  onClose,
}: {
  keyValue: string | null;
  onClose: () => void;
}) {
  const t = useTranslations('portal');
  const tCommon = useTranslations('common');

  return (
    <RevealDialog
      value={keyValue}
      onClose={onClose}
      title={t('key.dialogTitle')}
      description={t('key.dialogDescription')}
      copyLabel={t('key.copyKey')}
      copiedLabel={t('key.copied')}
      doneLabel={tCommon('done')}
      closeLabel={tCommon('close')}
      onCopyError={() => {
        toast.error(t('key.copyError'));
      }}
    />
  );
}
