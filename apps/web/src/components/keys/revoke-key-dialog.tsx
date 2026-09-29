'use client';

import { useTranslations } from 'next-intl';
import { ConfirmDialog } from '@open-gateway/ui';
import { useRevokeKey } from '@/hooks/use-keys';
import { confirmAction } from '@/lib/confirm-action';

interface RevokeKeyDialogProps {
  /** The key to revoke; `null` keeps the dialog closed. */
  target: { id: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
}

/** Destructive confirm for `POST /keys/:id/revoke`. Revocation cannot be undone. */
export function RevokeKeyDialog({ target, onOpenChange }: RevokeKeyDialogProps) {
  const t = useTranslations('keys');
  const tCommon = useTranslations('common');
  const revokeMutation = useRevokeKey();
  const keyName = target ? `"${target.name}"` : t('revokeDialog.thisKey');

  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={onOpenChange}
      title={t('revokeDialog.title')}
      description={t('revokeDialog.description', { keyName })}
      confirmLabel={t('revokeDialog.confirm')}
      pendingLabel={t('actions.revoking')}
      cancelLabel={tCommon('cancel')}
      isPending={revokeMutation.isPending}
      onConfirm={() => {
        if (!target) return;
        return confirmAction({
          run: () => revokeMutation.mutateAsync(target.id),
          success: () => t('revokeDialog.success', { name: target.name }),
          failed: t('revokeDialog.failed'),
          close: () => {
            onOpenChange(false);
          },
        });
      }}
    />
  );
}
