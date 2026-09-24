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
import { useDeleteRole } from '@/hooks/use-roles';

interface DeleteRoleDialogProps {
  target: { id: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
}

/** Destructive confirm for `DELETE /roles/:id`. Refused (409) while any member still holds it. */
export function DeleteRoleDialog({ target, onOpenChange }: DeleteRoleDialogProps) {
  const t = useTranslations('roles');
  const tCommon = useTranslations('common');
  const deleteMutation = useDeleteRole();

  const handleDelete = async () => {
    if (!target) return;
    try {
      await deleteMutation.mutateAsync(target.id);
      toast.success(t('deleteDialog.success', { name: target.name }));
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
