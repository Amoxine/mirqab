'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { Check, Copy, KeyRound, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { z } from 'zod';
import { PermissionGate } from '@/components/auth/permission-gate';
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
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/sonner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { QUOTA_PERIODS } from '@/components/keys/key-utils';
import {
  useCreateOAuthClient,
  useOAuthClients,
  useRevokeOAuthClient,
  useRotateOAuthClient,
  type OAuthClient,
  type OAuthClientSecret,
} from '@/hooks/use-oauth-clients';

const COLUMNS = 4;

/** Schema factory (not a module-level constant) because its error messages need `t`. */
function makeClientFormSchema(t: ReturnType<typeof useTranslations>) {
  const wholeNumber = (label: string, min: number) =>
    z
      .string()
      .refine(
        (v) => v === '' || (/^\d+$/.test(v) && Number(v) >= min),
        t('clients.wholeNumberError', { label, min }),
      );

  return z.object({
    name: z.string().trim().min(1, t('clients.nameRequired')).max(100, t('clients.nameTooLong')),
    rateLimitPerSecond: wholeNumber(t('config.rateLimit'), 0),
    quotaLimit: wholeNumber(t('clients.quotaFieldLabel'), 1),
    quotaPeriod: z.enum(QUOTA_PERIODS),
  });
}

type ClientFormValues = z.infer<ReturnType<typeof makeClientFormSchema>>;

const emptyClientForm: ClientFormValues = {
  name: '',
  rateLimitPerSecond: '',
  quotaLimit: '',
  quotaPeriod: 'MONTHLY',
};

/** `curl` the consumer can paste: fetch a token, then call the gateway with it. */
function curlSnippet(secret: OAuthClientSecret): string {
  return [
    `curl -s ${secret.tokenUrl} \\`,
    `  -d grant_type=client_credentials \\`,
    `  -d client_id=${secret.clientId} \\`,
    `  -d client_secret=${secret.clientSecret}`,
  ].join('\n');
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const t = useTranslations('apis');
  const [copied, setCopied] = useState(false);

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true);
          },
          () => {
            toast.error(t('clients.copyError'));
          },
        );
      }}
    >
      {copied ? <Check className="me-2 h-4 w-4" /> : <Copy className="me-2 h-4 w-4" />}
      {copied ? t('clients.copied') : label}
    </Button>
  );
}

function Secret({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium">{label}</p>
      <code className="block select-all break-all rounded-md bg-muted p-3 text-sm">{value}</code>
    </div>
  );
}

/**
 * Shows the credentials exactly once, right after they are minted. The secret only ever exists in
 * this response — Hydra does not return it again, and nothing stores it.
 */
function ClientSecretDialog({ secret, onClose }: { secret: OAuthClientSecret | null; onClose: () => void }) {
  const t = useTranslations('apis');
  const tCommon = useTranslations('common');
  return (
    <Dialog
      open={secret !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('clients.secretDialogTitle')}</DialogTitle>
          <DialogDescription>{t('clients.secretDialogDescription')}</DialogDescription>
        </DialogHeader>
        {secret && (
          <div className="space-y-4">
            <Secret label={t('clients.clientId')} value={secret.clientId} />
            <Secret label={t('clients.clientSecret')} value={secret.clientSecret} />
            <Secret label={t('clients.tokenUrl')} value={secret.tokenUrl} />
            <div className="space-y-1">
              <p className="text-sm font-medium">{t('clients.getToken')}</p>
              <pre
                data-testid="client-curl-snippet"
                className="overflow-x-auto rounded-md bg-muted p-3 text-xs"
              >
                {curlSnippet(secret)}
              </pre>
              <p className="text-xs text-muted-foreground">
                {t.rich('clients.getTokenHint', {
                  code1: (chunks) => <code>{chunks}</code>,
                  code2: (chunks) => <code>{chunks}</code>,
                })}
              </p>
            </div>
          </div>
        )}
        <DialogFooter className="gap-2 sm:gap-0">
          {secret && <CopyButton value={secret.clientSecret} label={t('clients.copySecret')} />}
          <Button type="button" onClick={onClose}>
            {tCommon('done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Mounted only while the sheet is open, so every open starts from blank defaults. */
function ClientForm({
  apiId,
  onOpenChange,
  onCreated,
}: {
  apiId: string;
  onOpenChange: (open: boolean) => void;
  onCreated: (secret: OAuthClientSecret) => void;
}) {
  const t = useTranslations('apis');
  const tCommon = useTranslations('common');
  const tKeys = useTranslations('keys');
  const createMutation = useCreateOAuthClient(apiId);
  const clientFormSchema = useMemo(() => makeClientFormSchema(t), [t]);
  const form = useForm<ClientFormValues>({
    resolver: zodResolver(clientFormSchema),
    defaultValues: emptyClientForm,
  });
  const quotaLimit = form.watch('quotaLimit');

  const onSubmit = async (values: ClientFormValues) => {
    const rate = values.rateLimitPerSecond === '' ? 0 : Number(values.rateLimitPerSecond);
    try {
      const created = await createMutation.mutateAsync({
        name: values.name.trim(),
        apiDefId: apiId,
        ...(rate > 0 ? { rateLimitPerSecond: rate } : {}),
        ...(values.quotaLimit
          ? { quotaLimit: Number(values.quotaLimit), quotaPeriod: values.quotaPeriod }
          : {}),
      });
      onCreated(created);
      toast.success(t('clients.createdToast'));
      form.reset();
      onOpenChange(false);
    } catch (error) {
      // Surfaces the API's message, e.g. the 400 for an API that is not synced to the gateway yet.
      toast.error(error instanceof Error ? error.message : t('clients.createError'));
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col gap-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('clients.nameLabel')}</FormLabel>
              <FormControl>
                <Input {...field} placeholder={t('clients.namePlaceholder')} />
              </FormControl>
              <FormDescription>{t('clients.nameDescription')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="rateLimitPerSecond"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('clients.rateLimitLabel')}</FormLabel>
              <FormControl>
                <Input {...field} type="number" inputMode="numeric" min={0} step={1} placeholder={t('config.unlimited')} />
              </FormControl>
              <FormDescription>{t('clients.rateLimitDescription')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="quotaLimit"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('clients.quotaLabel')}</FormLabel>
              <FormControl>
                <Input {...field} type="number" inputMode="numeric" min={1} step={1} placeholder={t('clients.noQuotaPlaceholder')} />
              </FormControl>
              <FormDescription>{t('clients.quotaDescription')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="quotaPeriod"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('clients.quotaPeriodLabel')}</FormLabel>
              <Select onValueChange={field.onChange} value={field.value} disabled={quotaLimit === ''}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {QUOTA_PERIODS.map((period) => (
                    <SelectItem key={period} value={period}>
                      {tKeys(`form.quotaPeriods.${period}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <SheetFooter className="mt-auto gap-2 pt-2 sm:gap-0">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              form.reset();
              onOpenChange(false);
            }}
          >
            {tCommon('cancel')}
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? t('clients.creating') : t('clients.createClient')}
          </Button>
        </SheetFooter>
      </form>
    </Form>
  );
}

function RevokeClientDialog({
  apiId,
  target,
  onOpenChange,
}: {
  apiId: string;
  target: OAuthClient | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('apis');
  const tCommon = useTranslations('common');
  const revokeMutation = useRevokeOAuthClient(apiId);

  const handleRevoke = async () => {
    if (!target) return;
    try {
      await revokeMutation.mutateAsync(target.clientId);
      toast.success(t('clients.revokedToast', { name: target.name }));
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('clients.revokeError'));
    }
  };

  const clientLabel = target ? `"${target.name}"` : t('clients.thisClient');

  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!revokeMutation.isPending) onOpenChange(open);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('clients.revokeTitle')}</AlertDialogTitle>
          <AlertDialogDescription>{t('clients.revokeDescription', { clientLabel })}</AlertDialogDescription>
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
            {revokeMutation.isPending ? t('clients.revoking') : t('clients.revokeClient')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * OAuth2 clients of one API: the data-plane credentials for `authType: OAUTH`.
 * The caller only mounts this for an OAUTH API — any other auth type ignores these credentials.
 */
export function ClientsTab({ apiId }: { apiId: string }) {
  const t = useTranslations('apis');
  const tCommon = useTranslations('common');
  const { data, isLoading, isError, error, refetch } = useOAuthClients(apiId);
  const rotateMutation = useRotateOAuthClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [secret, setSecret] = useState<OAuthClientSecret | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<OAuthClient | null>(null);

  const handleRotate = async (client: OAuthClient) => {
    try {
      setSecret(await rotateMutation.mutateAsync(client.clientId));
      toast.success(t('clients.secretIssuedToast', { name: client.name }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('clients.rotateError'));
    }
  };

  let body: ReactNode;
  if (isLoading) {
    body = Array.from({ length: 3 }).map((_, row) => (
      <TableRow key={row}>
        {Array.from({ length: COLUMNS }).map((__, cell) => (
          <TableCell key={cell}>
            <Skeleton className="h-5 w-24" />
          </TableCell>
        ))}
      </TableRow>
    ));
  } else if (isError) {
    body = (
      <TableRow>
        <TableCell colSpan={COLUMNS} className="h-24 text-center">
          <p className="text-sm text-destructive">{error.message}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => {
              void refetch();
            }}
          >
            {tCommon('retry')}
          </Button>
        </TableCell>
      </TableRow>
    );
  } else if (!data?.length) {
    body = (
      <TableRow>
        <TableCell colSpan={COLUMNS} className="h-24 text-center text-muted-foreground">
          {t('clients.empty')}
        </TableCell>
      </TableRow>
    );
  } else {
    body = data.map((client) => (
      <TableRow key={client.clientId}>
        <TableCell className="font-medium">{client.name}</TableCell>
        <TableCell className="break-all font-mono text-xs">{client.clientId}</TableCell>
        <TableCell>{client.createdAt ? new Date(client.createdAt).toLocaleDateString() : '—'}</TableCell>
        <TableCell className="text-end">
          <div className="flex justify-end gap-2">
            <PermissionGate permission="key:update">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={rotateMutation.isPending}
                onClick={() => {
                  void handleRotate(client);
                }}
              >
                <RefreshCw className="me-2 h-4 w-4" />
                {t('clients.rotate')}
              </Button>
            </PermissionGate>
            <PermissionGate permission="key:revoke">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setRevokeTarget(client);
                }}
              >
                <Trash2 className="me-2 h-4 w-4" />
                {t('clients.revoke')}
              </Button>
            </PermissionGate>
          </div>
        </TableCell>
      </TableRow>
    ));
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <KeyRound className="h-4 w-4" />
          {t('clients.description')}
        </p>
        <PermissionGate permission="key:create">
          <Button
            type="button"
            onClick={() => {
              setCreateOpen(true);
            }}
          >
            <Plus className="me-2 h-4 w-4" />
            {t('clients.createClient')}
          </Button>
        </PermissionGate>
      </div>

      {/* w-0 + min-w-full keeps the table's width out of the page layout, so it scrolls inside its own box. */}
      <div className="w-0 min-w-full rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tCommon('name')}</TableHead>
              <TableHead>{t('clients.clientId')}</TableHead>
              <TableHead>{tCommon('createdAt')}</TableHead>
              <TableHead className="text-end">{tCommon('actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>{body}</TableBody>
        </Table>
      </div>

      <Sheet open={createOpen} onOpenChange={setCreateOpen}>
        <SheetContent className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{t('clients.createSheetTitle')}</SheetTitle>
            <SheetDescription>{t('clients.createSheetDescription')}</SheetDescription>
          </SheetHeader>
          <ClientForm apiId={apiId} onOpenChange={setCreateOpen} onCreated={setSecret} />
        </SheetContent>
      </Sheet>

      <ClientSecretDialog
        secret={secret}
        onClose={() => {
          setSecret(null);
        }}
      />
      <RevokeClientDialog
        apiId={apiId}
        target={revokeTarget}
        onOpenChange={() => {
          setRevokeTarget(null);
        }}
      />
    </div>
  );
}
