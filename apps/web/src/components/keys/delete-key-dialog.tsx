'use client';

import { useTranslations } from 'next-intl';
import { ConfirmDialog } from '@open-gateway/ui';
import { useDeleteKey } from '@/hooks/use-keys';
import { confirmAction } from '@/lib/confirm-action';

interface DeleteKeyDialogProps {
  /** The key to delete; `null` keeps the dialog closed. */
  target: { id: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful delete, e.g. to navigate away from the detail page. */
  onDeleted?: () => void;
}

/** Destructive confirm for `DELETE /keys/:id` — permanent, unlike revoke. Only reachable for an
 * already-revoked or expired key; the API 409s an active one. */
export function DeleteKeyDialog({ target, onOpenChange, onDeleted }: DeleteKeyDialogProps) {
  const t = useTranslations('keys');
  const tCommon = useTranslations('common');
  const deleteMutation = useDeleteKey();
  const keyName = target ? `"${target.name}"` : t('revokeDialog.thisKey');

  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={onOpenChange}
      title={t('deleteDialog.title')}
      description={t('deleteDialog.description', { keyName })}
      confirmLabel={t('deleteDialog.confirm')}
      pendingLabel={t('actions.deleting')}
      cancelLabel={tCommon('cancel')}
      isPending={deleteMutation.isPending}
      onConfirm={() => {
        if (!target) return;
        return confirmAction({
          run: () => deleteMutation.mutateAsync(target.id),
          success: () => t('deleteDialog.success', { name: target.name }),
          failed: t('deleteDialog.failed'),
          close: () => {
            onOpenChange(false);
          },
          onDone: onDeleted,
        });
      }}
    />
  );
}
