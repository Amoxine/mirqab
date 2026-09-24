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
import { useDeleteCertificate } from '@/hooks/use-certificates';

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

  const handleDelete = async () => {
    if (!target) return;
    try {
      await deleteMutation.mutateAsync(target.id);
      toast.success(t('deleteDialog.success', { label: target.label }));
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
            {t('deleteDialog.description', { label: target ? `"${target.label}"` : '' })}
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
