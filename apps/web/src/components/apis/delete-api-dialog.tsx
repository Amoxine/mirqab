'use client';

import { useTranslations } from 'next-intl';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/sonner';
import { useDeleteApi } from '@/hooks/use-apis';

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

  const handleDelete = async () => {
    if (!api) return;
    try {
      await deleteMutation.mutateAsync(api.id);
      toast.success(t('delete.deletedToast', { name: api.name }));
      onClose();
      onDeleted?.();
    } catch (error) {
      // The server's message names the blocking keys; show it as-is.
      toast.error(error instanceof Error ? error.message : t('delete.error'));
      onClose();
    }
  };

  return (
    <AlertDialog
      open={api !== null}
      onOpenChange={(open) => {
        if (!open && !deleteMutation.isPending) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('delete.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t.rich('delete.description', {
              name: api?.name ?? '',
              bold: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteMutation.isPending}>{tCommon('cancel')}</AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            disabled={deleteMutation.isPending}
            onClick={() => {
              void handleDelete();
            }}
          >
            {deleteMutation.isPending ? t('delete.deleting') : tCommon('delete')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
