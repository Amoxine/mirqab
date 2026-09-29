'use client';

import { useTranslations } from 'next-intl';
import { ConfirmDialog } from '@open-gateway/ui';
import { useDeleteProduct } from '@/hooks/use-products';
import { confirmAction } from '@/lib/confirm-action';

interface DeleteProductDialogProps {
  target: { id: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
}

/** Destructive confirm for `DELETE /products/:id`. The APIs it bundled are untouched. */
export function DeleteProductDialog({ target, onOpenChange }: DeleteProductDialogProps) {
  const t = useTranslations('products');
  const tCommon = useTranslations('common');
  const deleteMutation = useDeleteProduct();

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
