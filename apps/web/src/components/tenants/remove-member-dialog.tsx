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
import { useRemoveMember } from '@/hooks/use-tenants';

interface RemoveMemberDialogProps {
  tenantId: string;
  /** The member to remove; the dialog is open while this is set. */
  member: { userId: string; email: string } | null;
  onClose: () => void;
}

/** Destructive confirm for removing a member. The server refuses to remove the last admin (409). */
export function RemoveMemberDialog({ tenantId, member, onClose }: RemoveMemberDialogProps) {
  const t = useTranslations('tenants');
  const tCommon = useTranslations('common');
  const removeMutation = useRemoveMember(tenantId);

  const handleRemove = async () => {
    if (!member) return;
    try {
      await removeMutation.mutateAsync(member.userId);
      toast.success(t('remove.successToast', { email: member.email }));
      onClose();
    } catch (error) {
      // Names the reason (e.g. "last admin") as sent by the server.
      toast.error(error instanceof Error ? error.message : t('remove.errorToast'));
      onClose();
    }
  };

  return (
    <AlertDialog
      open={member !== null}
      onOpenChange={(open) => {
        if (!open && !removeMutation.isPending) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('remove.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-medium text-foreground">{member?.email}</span>{' '}
            {t('remove.descriptionSuffix')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={removeMutation.isPending}>{tCommon('cancel')}</AlertDialogCancel>
          <AlertDialogAction
            disabled={removeMutation.isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(event) => {
              event.preventDefault();
              void handleRemove();
            }}
          >
            {removeMutation.isPending ? t('remove.pending') : t('remove.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
