'use client';

import { useTranslations } from 'next-intl';
import { ConfirmDialog } from '@open-gateway/ui';
import { useRotateKey } from '@/hooks/use-keys';
import { confirmAction } from '@/lib/confirm-action';

interface RotateKeyDialogProps {
  /** The key to rotate; `null` keeps the dialog closed. */
  target: { id: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
  /** The old credential stops working the moment this fires — the new raw value, shown once. */
  onRotated: (keyValue: string) => void;
}

/** Destructive confirm for `POST /keys/:id/rotate` — the old credential is invalidated immediately. */
export function RotateKeyDialog({ target, onOpenChange, onRotated }: RotateKeyDialogProps) {
  const t = useTranslations('keys');
  const tCommon = useTranslations('common');
  const rotateMutation = useRotateKey();
  const keyName = target ? `"${target.name}"` : t('revokeDialog.thisKey');

  return (
    <ConfirmDialog
      // Rotating is not a delete: the key lives on, so the confirm button is not red.
      tone="default"
      open={target !== null}
      onOpenChange={onOpenChange}
      title={t('rotateDialog.title')}
      description={t('rotateDialog.description', { keyName })}
      confirmLabel={t('rotateDialog.confirm')}
      pendingLabel={t('actions.rotating')}
      cancelLabel={tCommon('cancel')}
      isPending={rotateMutation.isPending}
      onConfirm={() => {
        if (!target) return;
        return confirmAction({
          run: () => rotateMutation.mutateAsync(target.id),
          failed: t('rotateDialog.failed'),
          close: () => {
            onOpenChange(false);
          },
          onDone: (result) => {
            onRotated(result.keyValue);
          },
        });
      }}
    />
  );
}
