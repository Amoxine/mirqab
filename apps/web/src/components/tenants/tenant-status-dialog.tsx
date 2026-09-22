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
import { useArchiveTenant, useUpdateTenant } from '@/hooks/use-tenants';

type StatusAction = 'suspend' | 'reactivate' | 'archive';

interface TenantStatusDialogProps {
  /** The tenant to act on; the dialog is open while this is set. */
  tenant: { id: string; name: string } | null;
  action: StatusAction;
  onClose: () => void;
  /** Called after a successful archive (e.g. to leave the detail page). */
  onArchived?: () => void;
}

/** Destructive-ish confirm for suspend/reactivate/archive — all three change a tenant's status. */
export function TenantStatusDialog({ tenant, action, onClose, onArchived }: TenantStatusDialogProps) {
  const t = useTranslations('tenants');
  const tCommon = useTranslations('common');
  const updateMutation = useUpdateTenant(tenant?.id ?? '');
  const archiveMutation = useArchiveTenant();
  const isPending = updateMutation.isPending || archiveMutation.isPending;
  const copy = {
    title: t(`statusDialog.${action}.title`),
    description: t(`statusDialog.${action}.description`),
    confirmLabel: t(`statusDialog.${action}.confirm`),
    pendingLabel: t(`statusDialog.${action}.pending`),
  };

  const handleConfirm = async () => {
    if (!tenant) return;
    try {
      if (action === 'archive') {
        await archiveMutation.mutateAsync(tenant.id);
        toast.success(t('statusDialog.archivedToast', { name: tenant.name }));
        onArchived?.();
      } else {
        await updateMutation.mutateAsync({ status: action === 'suspend' ? 'SUSPENDED' : 'ACTIVE' });
        toast.success(
          t(action === 'suspend' ? 'statusDialog.suspendedToast' : 'statusDialog.reactivatedToast', {
            name: tenant.name,
          }),
        );
      }
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('statusDialog.errorToast'));
      onClose();
    }
  };

  return (
    <AlertDialog
      open={tenant !== null}
      onOpenChange={(open) => {
        if (!open && !isPending) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-medium text-foreground">{tenant?.name}</span>{' — '}{copy.description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>{tCommon('cancel')}</AlertDialogCancel>
          <AlertDialogAction
            disabled={isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(event) => {
              // Radix closes on Action click; hold it open until the request settles.
              event.preventDefault();
              void handleConfirm();
            }}
          >
            {isPending ? copy.pendingLabel : copy.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
