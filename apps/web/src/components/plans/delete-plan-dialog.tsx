'use client';

import { useTranslations } from 'next-intl';
import { ConfirmDialog } from '@open-gateway/ui';
import { useDeletePlan } from '@/hooks/use-plans';
import { confirmAction } from '@/lib/confirm-action';

interface DeletePlanDialogProps {
  target: { id: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
}

/** Destructive confirm for `DELETE /plans/:id`. Keys on this plan survive, plan-less (`SET NULL`). */
export function DeletePlanDialog({ target, onOpenChange }: DeletePlanDialogProps) {
  const t = useTranslations('plans');
  const tCommon = useTranslations('common');
  const deleteMutation = useDeletePlan();

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
          success: (result) =>
            result.unassignedKeys > 0
              ? t('deleteDialog.successWithKeys', {
                  name: target.name,
                  count: result.unassignedKeys,
                })
              : t('deleteDialog.success', { name: target.name }),
          failed: t('deleteDialog.failed'),
          close: () => {
            onOpenChange(false);
          },
        });
      }}
    />
  );
}
