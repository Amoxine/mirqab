'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle, ArrowLeft, KeyRound, Plus } from 'lucide-react';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { KeyRevealDialog } from '@/components/portal/key-reveal-dialog';
import { SubscribeSheet } from '@/components/portal/subscribe-sheet';
import { SubscriptionUsage } from '@/components/portal/subscription-usage';
import { useRevokePortalSubscription, usePortalSubscriptions, type PortalSubscription } from '@/hooks/use-portal';

const STATUS_VARIANT: Record<PortalSubscription['status'], 'default' | 'secondary' | 'destructive'> = {
  APPROVED: 'default',
  PENDING: 'secondary',
  REVOKED: 'destructive',
};

function RevokeDialog({
  applicationId,
  target,
  onClose,
}: {
  applicationId: string;
  target: PortalSubscription | null;
  onClose: () => void;
}) {
  const t = useTranslations('portal');
  const tCommon = useTranslations('common');
  const revokeMutation = useRevokePortalSubscription(applicationId);

  const handleRevoke = async () => {
    if (!target) return;
    try {
      await revokeMutation.mutateAsync(target.id);
      onClose();
    } catch {
      // Left open on failure — the AlertDialogAction below stays disabled while pending and the
      // mutation's own error is not silently swallowed, just not toasted here (no `t` hook needed
      // beyond this file's own).
    }
  };

  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!revokeMutation.isPending) onClose();
        void open;
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('subscription.revokeTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('subscription.revokeDescription', { product: target?.productName ?? '' })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={revokeMutation.isPending}>{tCommon('cancel')}</AlertDialogCancel>
          <AlertDialogAction
            disabled={revokeMutation.isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(event) => {
              event.preventDefault();
              void handleRevoke();
            }}
          >
            {revokeMutation.isPending ? t('subscription.revoking') : t('subscription.revoke')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default function PortalApplicationPage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations('portal');
  const tCommon = useTranslations('common');
  const [subscribeOpen, setSubscribeOpen] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<PortalSubscription | null>(null);
  const { data: subscriptions, isLoading, isError, error, refetch } = usePortalSubscriptions(id);

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Button asChild variant="ghost" size="sm" className="-ms-3">
          <Link href="/portal/applications">
            <ArrowLeft className="me-2 h-4 w-4" />
            {t('applications.title')}
          </Link>
        </Button>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-3xl font-bold tracking-tight">{t('subscription.title')}</h1>
          <Button
            type="button"
            onClick={() => {
              setSubscribeOpen(true);
            }}
          >
            <Plus className="me-2 h-4 w-4" />
            {t('subscribe.title')}
          </Button>
        </div>
      </div>

      {isLoading && (
        <div className="space-y-3" aria-busy="true">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      )}

      {isError && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <AlertTriangle className="h-8 w-8 text-destructive" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">{error.message}</p>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void refetch();
              }}
            >
              {tCommon('retry')}
            </Button>
          </CardContent>
        </Card>
      )}

      {!isLoading && !isError && subscriptions?.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <KeyRound className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">{t('subscription.empty')}</p>
          </CardContent>
        </Card>
      )}

      {!isLoading &&
        !isError &&
        subscriptions &&
        subscriptions.length > 0 &&
        subscriptions.map((sub) => (
          <Card key={sub.id}>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
              <div className="flex items-center gap-2">
                <CardTitle className="text-base">{sub.productName}</CardTitle>
                <Badge variant={STATUS_VARIANT[sub.status]}>{t(`subscription.status.${sub.status}`)}</Badge>
              </div>
              {sub.status !== 'REVOKED' && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setRevokeTarget(sub);
                  }}
                >
                  {t('subscription.revoke')}
                </Button>
              )}
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">{t('subscription.plan', { plan: sub.planName })}</p>
              {sub.status === 'APPROVED' && <SubscriptionUsage applicationId={id} subscriptionId={sub.id} />}
              {sub.status === 'PENDING' && (
                <p className="text-sm text-muted-foreground">{t('subscription.pendingApproval')}</p>
              )}
            </CardContent>
          </Card>
        ))}

      <SubscribeSheet
        applicationId={id}
        open={subscribeOpen}
        onOpenChange={setSubscribeOpen}
        onSubscribed={(subscription) => {
          if (subscription.keyValue) setRevealedKey(subscription.keyValue);
        }}
      />
      <KeyRevealDialog
        keyValue={revealedKey}
        onClose={() => {
          setRevealedKey(null);
        }}
      />
      <RevokeDialog
        applicationId={id}
        target={revokeTarget}
        onClose={() => {
          setRevokeTarget(null);
        }}
      />
    </div>
  );
}
