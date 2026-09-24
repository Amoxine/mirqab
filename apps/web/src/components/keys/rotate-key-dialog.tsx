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
import { useRotateKey } from '@/hooks/use-keys';

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

  const handleRotate = async () => {
    if (!target) return;
    try {
      const result = await rotateMutation.mutateAsync(target.id);
      onOpenChange(false);
      onRotated(result.keyValue);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('rotateDialog.failed'));
    }
  };

  const keyName = target ? `"${target.name}"` : t('revokeDialog.thisKey');

  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!rotateMutation.isPending) onOpenChange(open);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('rotateDialog.title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('rotateDialog.description', { keyName })}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={rotateMutation.isPending}>{tCommon('cancel')}</AlertDialogCancel>
          <AlertDialogAction
            disabled={rotateMutation.isPending}
            onClick={(event) => {
              event.preventDefault();
              void handleRotate();
            }}
          >
            {rotateMutation.isPending ? t('actions.rotating') : t('rotateDialog.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
