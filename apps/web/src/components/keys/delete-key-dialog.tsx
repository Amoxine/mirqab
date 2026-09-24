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
import { useDeleteKey } from '@/hooks/use-keys';

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

  const handleDelete = async () => {
    if (!target) return;
    try {
      await deleteMutation.mutateAsync(target.id);
      toast.success(t('deleteDialog.success', { name: target.name }));
      onOpenChange(false);
      onDeleted?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('deleteDialog.failed'));
    }
  };

  const keyName = target ? `"${target.name}"` : t('revokeDialog.thisKey');

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
          <AlertDialogDescription>{t('deleteDialog.description', { keyName })}</AlertDialogDescription>
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
            {deleteMutation.isPending ? t('actions.deleting') : t('deleteDialog.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
