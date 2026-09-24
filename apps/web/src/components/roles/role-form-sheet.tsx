'use client';

import { useMemo } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/sonner';
import { usePermissionCatalog, useCreateRole, useUpdateRole, type Role } from '@/hooks/use-roles';

/** `UserTenant.role` is matched by plain string against `Role.name`, and `isSuperAdmin` matches
 * that string globally with no tenant scoping — this is the one name the backend structurally
 * refuses (403) regardless of who asks, so the form refuses to even construct the request. */
const RESERVED_ROLE_NAME = 'super_admin';

function makeRoleFormSchema(t: (key: string, values?: Record<string, string>) => string) {
  return z.object({
    name: z
      .string()
      .trim()
      .min(2, t('form.errors.nameTooShort'))
      .max(60, t('form.errors.nameTooLong'))
      .refine((v) => v.toLowerCase() !== RESERVED_ROLE_NAME, t('form.errors.nameReserved', { name: RESERVED_ROLE_NAME })),
    description: z.string().max(500).optional().or(z.literal('')),
    permissions: z.array(z.string()),
  });
}
type RoleFormValues = z.infer<ReturnType<typeof makeRoleFormSchema>>;

const emptyValues: RoleFormValues = { name: '', description: '', permissions: [] };

const valuesFromRole = (role: Role): RoleFormValues => ({
  name: role.name,
  description: role.description ?? '',
  permissions: role.permissions,
});

type RoleFormSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & ({ mode: 'create' } | { mode: 'edit'; role: Role });

/**
 * Create/edit sheet for a custom role (U18) — name/description plus the permission matrix. Writes
 * `RolePermission` rows directly; a role's members pick it up on their NEXT request with no
 * re-login, since `AuthService#loadPermissions` re-derives permissions from Postgres every time
 * (never baked into the JWT — see `jwt.strategy.ts` calling `resolveSession` per request).
 */
export function RoleFormSheet(props: RoleFormSheetProps) {
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg">
        <RoleFormBody {...props} />
      </SheetContent>
    </Sheet>
  );
}

function RoleFormBody(props: RoleFormSheetProps) {
  const t = useTranslations('roles');
  const tCommon = useTranslations('common');
  const { onOpenChange } = props;
  const role = props.mode === 'edit' ? props.role : undefined;
  const createMutation = useCreateRole();
  const updateMutation = useUpdateRole(role?.id ?? '');
  const { data: catalog, isLoading: catalogLoading } = usePermissionCatalog();

  const schema = useMemo(() => makeRoleFormSchema(t), [t]);
  const form = useForm<RoleFormValues>({
    resolver: zodResolver(schema),
    defaultValues: role ? valuesFromRole(role) : emptyValues,
  });

  const isReserved = role?.name.toLowerCase() === RESERVED_ROLE_NAME;

  const handleClose = () => {
    form.reset();
    onOpenChange(false);
  };

  const onSubmit = async (values: RoleFormValues) => {
    const payload = {
      name: values.name.trim(),
      description: (values.description ?? '').length > 0 ? values.description : undefined,
      permissions: values.permissions,
    };
    try {
      if (role) {
        await updateMutation.mutateAsync(payload);
        toast.success(t('form.updateSuccess'));
      } else {
        await createMutation.mutateAsync(payload);
        toast.success(t('form.createSuccess'));
      }
      handleClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t(role ? 'form.updateFailed' : 'form.createFailed'));
    }
  };

  const isSubmitting = form.formState.isSubmitting;

  // resources x actions grid — a cell exists only when the catalogue actually has that permission,
  // which is what keeps this matrix structurally unable to offer anything platform-scoped: it can
  // only ever check a box for a name `GET /roles/permissions` returned.
  const resources = useMemo(() => [...new Set((catalog ?? []).map((p) => p.resource))].sort(), [catalog]);
  const actions = useMemo(() => [...new Set((catalog ?? []).map((p) => p.action))].sort(), [catalog]);
  const byResourceAction = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of catalog ?? []) map.set(`${p.resource}:${p.action}`, p.name);
    return map;
  }, [catalog]);

  return (
    <>
      <SheetHeader>
        <SheetTitle>{role ? t('form.editTitle', { name: role.name }) : t('form.createTitle')}</SheetTitle>
        <SheetDescription>{role ? t('form.editDescription') : t('form.createDescription')}</SheetDescription>
      </SheetHeader>
      {isReserved ? (
        <p className="text-sm text-muted-foreground">{t('form.reservedNotice', { name: RESERVED_ROLE_NAME })}</p>
      ) : (
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col gap-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tCommon('name')}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder={t('form.namePlaceholder')} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('fields.description')}</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={2} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="permissions"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('fields.permissions')}</FormLabel>
                  <FormDescription>{t('form.permissionsHint')}</FormDescription>
                  {catalogLoading ? (
                    <Skeleton className="h-48 w-full" />
                  ) : (
                    <ScrollArea className="h-64 rounded-md border">
                      <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-background">
                          <tr>
                            <th className="p-2 text-start font-medium">{t('matrix.resource')}</th>
                            {actions.map((action) => (
                              <th key={action} className="p-2 text-center font-medium">
                                {t(`matrix.actions.${action}`)}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {resources.map((resource) => (
                            <tr key={resource} className="border-t">
                              <td className="p-2 font-medium capitalize">{resource}</td>
                              {actions.map((action) => {
                                const name = byResourceAction.get(`${resource}:${action}`);
                                return (
                                  <td key={action} className="p-2 text-center">
                                    {name ? (
                                      <Checkbox
                                        aria-label={name}
                                        checked={field.value.includes(name)}
                                        onCheckedChange={(checked) => {
                                          field.onChange(
                                            checked
                                              ? [...field.value, name]
                                              : field.value.filter((n) => n !== name),
                                          );
                                        }}
                                      />
                                    ) : (
                                      <span className="text-muted-foreground">{'—'}</span>
                                    )}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </ScrollArea>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
            <SheetFooter className="mt-auto gap-2 pt-2 sm:gap-0">
              <Button type="button" variant="outline" onClick={handleClose} disabled={isSubmitting}>
                {tCommon('cancel')}
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {role
                  ? t(isSubmitting ? 'form.submitSaving' : 'form.submitSave')
                  : t(isSubmitting ? 'form.submitCreating' : 'form.submitCreate')}
              </Button>
            </SheetFooter>
          </form>
        </Form>
      )}
    </>
  );
}
