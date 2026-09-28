'use client';

import { useMemo, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { toast } from '@/components/ui/sonner';
import { useInviteByEmail, useInviteMember, useLookupUser } from '@/hooks/use-tenants';
import { ApiRequestError } from '@/lib/api-client';

// 'super_admin' is deliberately not offered here — see keto.ts's relationForRole comment: it is a
// system-wide bypass keyed only on the role name, not a per-tenant permission level, so handing it
// out from an invite form would let an admin grant a second account access far beyond their own.
//
/** `t` is `useTranslations('tenants')` — messages need it, so this is a factory (called once via
 * `useMemo` below, not a static schema); the shape/validation logic still lives at module scope. */
function makeInviteSchema(t: (key: string) => string) {
  return z.object({
    email: z.string().min(1, t('invite.errors.emailRequired')).email(t('invite.errors.emailInvalid')),
    role: z.enum(['admin', 'operator', 'viewer']),
  });
}
type InviteValues = z.infer<ReturnType<typeof makeInviteSchema>>;

interface InviteMemberSheetProps {
  tenantId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Invite-by-email sheet: looks the email up first. A match gets assigned immediately.
 *
 * The "no match → offer to invite that email instead" branch (V1-USR-01, Option F) is held back
 * for this release — security-v1 found that an attacker who registers the invitee's email first
 * can take over the pending row once the real owner verifies it (see team-verify handoff). It is
 * gated behind `NEXT_PUBLIC_FEATURE_INVITE_BY_EMAIL`, off by default, matching the backend's own
 * `FEATURE_INVITE_BY_EMAIL` gate on `POST :id/users/invite` (404 when off). With the flag off, "no
 * match" goes back to the plain field error this sheet had before the feature existed. */
export function InviteMemberSheet(props: InviteMemberSheetProps) {
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent className="w-full sm:max-w-sm">
        <InviteMemberForm {...props} />
      </SheetContent>
    </Sheet>
  );
}

function InviteMemberForm({ tenantId, onOpenChange }: InviteMemberSheetProps) {
  const t = useTranslations('tenants');
  const tCommon = useTranslations('common');
  const lookupMutation = useLookupUser(tenantId);
  const inviteMutation = useInviteMember(tenantId);
  const inviteByEmailMutation = useInviteByEmail(tenantId);
  // Read per render (not hoisted to module scope) so a test can flip the flag before rendering.
  const inviteByEmailEnabled = process.env.NEXT_PUBLIC_FEATURE_INVITE_BY_EMAIL === 'true';
  // Set once a lookup finds nobody, for this exact email; any further edit to the email clears it,
  // so the offer to invite never survives onto an email it was never shown for.
  const [offerInviteFor, setOfferInviteFor] = useState<string | null>(null);

  const inviteSchema = useMemo(() => makeInviteSchema(t), [t]);
  const form = useForm<InviteValues>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: '', role: 'viewer' },
  });

  const handleClose = () => {
    form.reset();
    setOfferInviteFor(null);
    onOpenChange(false);
  };

  const onSubmit = async (values: InviteValues) => {
    if (inviteByEmailEnabled && offerInviteFor && offerInviteFor === values.email) {
      try {
        await inviteByEmailMutation.mutateAsync({ email: values.email, role: values.role });
        toast.success(t('invite.inviteSuccessToast', { email: values.email }));
        handleClose();
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 409) {
          form.setError('email', { message: t('invite.alreadyInvitedError') });
          setOfferInviteFor(null);
          return;
        }
        toast.error(error instanceof Error ? error.message : t('invite.errorToast'));
      }
      return;
    }

    try {
      const found = await lookupMutation.mutateAsync(values.email);
      if (!found) {
        if (inviteByEmailEnabled) {
          setOfferInviteFor(values.email);
        } else {
          form.setError('email', { message: t('invite.notFoundError') });
        }
        return;
      }
      if (found.isMember) {
        form.setError('email', { message: t('invite.alreadyMemberError') });
        return;
      }
      await inviteMutation.mutateAsync({ userId: found.id, role: values.role });
      toast.success(t('invite.successToast', { email: found.email }));
      handleClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('invite.errorToast'));
    }
  };

  const isSubmitting = form.formState.isSubmitting;
  const isOfferingInvite = inviteByEmailEnabled && offerInviteFor !== null && offerInviteFor === form.watch('email');

  return (
    <>
      <SheetHeader>
        <SheetTitle>{t('invite.title')}</SheetTitle>
        <SheetDescription>{t('invite.description')}</SheetDescription>
      </SheetHeader>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{tCommon('email')}</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    type="email"
                    placeholder={t('invite.emailPlaceholder')}
                    onChange={(e) => {
                      field.onChange(e);
                      setOfferInviteFor(null);
                    }}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="role"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('fields.role')}</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder={t('invite.rolePlaceholder')} />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="admin">{t('roles.admin')}</SelectItem>
                    <SelectItem value="operator">{t('roles.operator')}</SelectItem>
                    <SelectItem value="viewer">{t('roles.viewer')}</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          {isOfferingInvite && (
            <p role="status" className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
              {t('invite.offerText', { email: offerInviteFor })}
            </p>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={handleClose} disabled={isSubmitting}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" loading={isSubmitting}>
              {isSubmitting
                ? isOfferingInvite
                  ? t('invite.inviteSubmitting')
                  : t('invite.submitting')
                : isOfferingInvite
                  ? t('invite.inviteSubmit')
                  : t('invite.submit')}
            </Button>
          </div>
        </form>
      </Form>
    </>
  );
}
