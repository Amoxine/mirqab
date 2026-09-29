'use client';

import { useTranslations } from 'next-intl';
import { ConfirmDialog } from '@open-gateway/ui';
import { useDeleteApi } from '@/hooks/use-apis';
import { confirmAction } from '@/lib/confirm-action';

interface DeleteApiDialogProps {
  /** The API to delete; the dialog is open while this is set. */
  api: { id: string; name: string } | null;
  onClose: () => void;
  /** Called after a successful delete (e.g. to leave the detail page). */
  onDeleted?: () => void;
}

/** Destructive confirm for deleting an API. A refused delete (409: active keys) shows the server's message. */
export function DeleteApiDialog({ api, onClose, onDeleted }: DeleteApiDialogProps) {
  const t = useTranslations('apis');
  const tCommon = useTranslations('common');
  const deleteMutation = useDeleteApi();

  return (
    <ConfirmDialog
      open={api !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('delete.title')}
      description={t.rich('delete.description', {
        name: api?.name ?? '',
        bold: (chunks) => <span className="text-foreground font-medium">{chunks}</span>,
      })}
      confirmLabel={tCommon('delete')}
      pendingLabel={t('delete.deleting')}
      cancelLabel={tCommon('cancel')}
      isPending={deleteMutation.isPending}
      onConfirm={() => {
        if (!api) return;
        return confirmAction({
          run: () => deleteMutation.mutateAsync(api.id),
          success: () => t('delete.deletedToast', { name: api.name }),
          // The server's message names the blocking keys; show it as-is, and close either way.
          failed: t('delete.error'),
          close: onClose,
          closeOnError: true,
          onDone: onDeleted,
        });
      }}
    />
  );
}
