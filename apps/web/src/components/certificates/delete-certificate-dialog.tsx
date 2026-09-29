'use client';

import { useTranslations } from 'next-intl';
import { ConfirmDialog } from '@open-gateway/ui';
import { useDeleteCertificate } from '@/hooks/use-certificates';
import { confirmAction } from '@/lib/confirm-action';

interface DeleteCertificateDialogProps {
  target: { id: string; label: string } | null;
  onOpenChange: (open: boolean) => void;
}

/** Destructive confirm for `DELETE /certificates/:id`. The API answers 409 (surfaced as the toast)
 * while any API still has this certificate attached: live-measured, a delete does NOT stop an
 * attached API presenting it, so revoking is detach-then-delete, never delete alone. */
export function DeleteCertificateDialog({ target, onOpenChange }: DeleteCertificateDialogProps) {
  const t = useTranslations('certificates');
  const tCommon = useTranslations('common');
  const deleteMutation = useDeleteCertificate();

  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={onOpenChange}
      title={t('deleteDialog.title')}
      description={t('deleteDialog.description', { label: target ? `"${target.label}"` : '' })}
      confirmLabel={t('deleteDialog.confirm')}
      pendingLabel={t('deleteDialog.pending')}
      cancelLabel={tCommon('cancel')}
      isPending={deleteMutation.isPending}
      onConfirm={() => {
        if (!target) return;
        return confirmAction({
          run: () => deleteMutation.mutateAsync(target.id),
          success: () => t('deleteDialog.success', { label: target.label }),
          failed: t('deleteDialog.failed'),
          close: () => {
            onOpenChange(false);
          },
        });
      }}
    />
  );
}
