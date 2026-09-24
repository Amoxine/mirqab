'use client';

import { useMemo } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { Lock } from 'lucide-react';
import { z } from 'zod';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { useUpdateApi, type ApiDefinition } from '@/hooks/use-apis';
import { ConfigSheet, ConfigSheetFooter } from './config-sheet';

// The auth types this Sheet can set. JWT needs its own bring-your-own-JWKS section (not WP15c, see
// api-form-schema.ts's own exclusion) and HMAC is PARKED — mapper exists but no signing-string
// variant produced a working request against Tyk OSS 5.15.0 (WP15c finding). Offering either here
// would be a control that implies it works; both stay out of the select instead.
const AUTH_TYPES = ['NONE', 'AUTH_TOKEN', 'OAUTH', 'BASIC'] as const;

type Translate = (key: string) => string;

function makeSchema(t: Translate) {
  return z.object({
    authType: z.enum(AUTH_TYPES),
    authHeaderName: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]*$/, t('designer.authentication.headerNameInvalid')),
  });
}

type Values = z.infer<ReturnType<typeof makeSchema>>;

function toFormInput(api: ApiDefinition): Values {
  return {
    authType: AUTH_TYPES.find((type) => type === api.authType) ?? 'NONE',
    authHeaderName: api.config?.authHeaderName ?? '',
  };
}

interface AuthenticationSheetProps {
  api: ApiDefinition;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** WP15c: which auth scheme the API enforces, and which header carries the credential. */
export function AuthenticationSheet({ api, open, onOpenChange }: AuthenticationSheetProps) {
  const t = useTranslations('apis');
  const updateMutation = useUpdateApi(api.id);
  const schema = useMemo(() => makeSchema(t), [t]);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: toFormInput(api) });

  const handleClose = () => {
    form.reset();
    onOpenChange(false);
  };

  const onSubmit = async (values: Values) => {
    try {
      await updateMutation.mutateAsync({
        authType: values.authType,
        config: { authHeaderName: values.authHeaderName === '' ? 'Authorization' : values.authHeaderName },
      });
      toast.success(t('designer.savedToast'));
      handleClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('designer.saveError'));
    }
  };

  return (
    <ConfigSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('designer.authentication.title')}
      description={t('designer.authentication.description')}
    >
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col gap-4">
          <FormField
            control={form.control}
            name="authType"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('field.authType')}</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {AUTH_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {t(`authTypes.${type}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="authHeaderName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('designer.authentication.headerName')}</FormLabel>
                <FormControl>
                  <Input {...field} placeholder="Authorization" />
                </FormControl>
                <FormDescription>{t('designer.authentication.headerNameDescription')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <div className="flex items-start gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>{t('designer.authentication.hmacParked')}</p>
          </div>
          <ConfigSheetFooter isSubmitting={form.formState.isSubmitting} onCancel={handleClose} />
        </form>
      </Form>
    </ConfigSheet>
  );
}
