'use client';

import { useTranslations } from 'next-intl';
import { RevealDialog } from '@open-gateway/ui';
import { toast } from '@/components/ui/sonner';

interface KeyCreatedDialogProps {
  /** The raw key, held in memory by the caller only. `null` closes the dialog. */
  keyValue: string | null;
  onClose: () => void;
}

/** Shows the raw key exactly once, right after creation (and after a rotation). */
export function KeyCreatedDialog({ keyValue, onClose }: KeyCreatedDialogProps) {
  const t = useTranslations('keys');
  const tCommon = useTranslations('common');

  return (
    <RevealDialog
      value={keyValue}
      onClose={onClose}
      title={t('createdDialog.title')}
      description={t('createdDialog.description')}
      copyLabel={t('createdDialog.copy')}
      copiedLabel={t('createdDialog.copied')}
      doneLabel={tCommon('done')}
      closeLabel={tCommon('close')}
      onCopyError={() => {
        toast.error(t('createdDialog.copyFailed'));
      }}
      valueTestId="created-key-value"
    />
  );
}
