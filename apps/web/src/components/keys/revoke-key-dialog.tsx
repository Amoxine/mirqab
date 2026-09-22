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
import { useRevokeKey } from '@/hooks/use-keys';

interface RevokeKeyDialogProps {
  /** The key to revoke; `null` keeps the dialog closed. */
  target: { id: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
}

/** Destructive confirm for `POST /keys/:id/revoke`. Revocation cannot be undone. */
export function RevokeKeyDialog({ target, onOpenChange }: RevokeKeyDialogProps) {
  const t = useTranslations('keys');
  const tCommon = useTranslations('common');
  const revokeMutation = useRevokeKey();

  const handleRevoke = async () => {
    if (!target) return;
    try {
      await revokeMutation.mutateAsync(target.id);
      toast.success(t('revokeDialog.success', { name: target.name }));
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('revokeDialog.failed'));
    }
  };

  const keyName = target ? `"${target.name}"` : t('revokeDialog.thisKey');

  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => {
        // Keep the dialog open while the request is in flight.
        if (!revokeMutation.isPending) onOpenChange(open);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('revokeDialog.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('revokeDialog.description', { keyName })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={revokeMutation.isPending}>{tCommon('cancel')}</AlertDialogCancel>
          <AlertDialogAction
            disabled={revokeMutation.isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(event) => {
              // Radix closes on Action click; hold it open until the request settles.
              event.preventDefault();
              void handleRevoke();
            }}
          >
            {revokeMutation.isPending ? t('actions.revoking') : t('revokeDialog.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
