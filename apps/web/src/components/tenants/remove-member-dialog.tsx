'use client';

import { useTranslations } from 'next-intl';
import { ConfirmDialog } from '@open-gateway/ui';
import { useRemoveMember } from '@/hooks/use-tenants';
import { confirmAction } from '@/lib/confirm-action';

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

  return (
    <ConfirmDialog
      open={member !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('remove.title')}
      description={
        <>
          <span className="text-foreground font-medium">{member?.email}</span>{' '}
          {t('remove.descriptionSuffix')}
        </>
      }
      confirmLabel={t('remove.confirm')}
      pendingLabel={t('remove.pending')}
      cancelLabel={tCommon('cancel')}
      isPending={removeMutation.isPending}
      onConfirm={() => {
        if (!member) return;
        return confirmAction({
          run: () => removeMutation.mutateAsync(member.userId),
          success: () => t('remove.successToast', { email: member.email }),
          // Names the reason (e.g. "last admin") as sent by the server.
          failed: t('remove.errorToast'),
          close: onClose,
          closeOnError: true,
        });
      }}
    />
  );
}
