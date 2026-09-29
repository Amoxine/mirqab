'use client';

import { useTranslations } from 'next-intl';
import { ConfirmDialog } from '@open-gateway/ui';
import { useDeleteRole } from '@/hooks/use-roles';
import { confirmAction } from '@/lib/confirm-action';

interface DeleteRoleDialogProps {
  target: { id: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
}

/** Destructive confirm for `DELETE /roles/:id`. Refused (409) while any member still holds it. */
export function DeleteRoleDialog({ target, onOpenChange }: DeleteRoleDialogProps) {
  const t = useTranslations('roles');
  const tCommon = useTranslations('common');
  const deleteMutation = useDeleteRole();

  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={onOpenChange}
      title={t('deleteDialog.title')}
      description={t('deleteDialog.description', { name: target ? `"${target.name}"` : '' })}
      confirmLabel={t('deleteDialog.confirm')}
      pendingLabel={t('deleteDialog.pending')}
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
        });
      }}
    />
  );
}
