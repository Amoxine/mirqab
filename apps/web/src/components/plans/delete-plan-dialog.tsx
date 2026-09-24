'use client';

import { useTranslations } from 'next-intl';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from '@/components/ui/sonner';
import { useDeletePlan } from '@/hooks/use-plans';

interface DeletePlanDialogProps {
  target: { id: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
}

/** Destructive confirm for `DELETE /plans/:id`. Keys on this plan survive, plan-less (`SET NULL`). */
export function DeletePlanDialog({ target, onOpenChange }: DeletePlanDialogProps) {
  const t = useTranslations('plans');
  const tCommon = useTranslations('common');
  const deleteMutation = useDeletePlan();

  const handleDelete = async () => {
    if (!target) return;
    try {
      const result = await deleteMutation.mutateAsync(target.id);
      toast.success(
        result.unassignedKeys > 0
          ? t('deleteDialog.successWithKeys', { name: target.name, count: result.unassignedKeys })
          : t('deleteDialog.success', { name: target.name }),
      );
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('deleteDialog.failed'));
    }
  };

  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!deleteMutation.isPending) onOpenChange(open);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('deleteDialog.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('deleteDialog.description', { name: target ? `"${target.name}"` : '' })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteMutation.isPending}>{tCommon('cancel')}</AlertDialogCancel>
          <AlertDialogAction
            disabled={deleteMutation.isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(event) => {
              event.preventDefault();
              void handleDelete();
            }}
          >
            {deleteMutation.isPending ? t('deleteDialog.pending') : t('deleteDialog.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
