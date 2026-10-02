'use client';

import { useState } from 'react';
import Link from 'next/link';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { CheckCircle2 } from 'lucide-react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { portalApi, ApiRequestError } from '@/lib/portal-api-client';

/**
 * NOT a `KratosFlowForm` reuse, and deliberately so: `DeveloperService.register` (WP22) creates the
 * Kratos identity through the ADMIN api directly rather than Kratos's own self-service registration
 * flow (same shortcut `migrate-users-to-kratos.ts` uses — see that service's own comment), because a
 * developer's registration also has to provision the `Developer` row and pick which tenant's portal
 * it belongs to in the SAME call. Kratos's flow components come back for what they actually run:
 * login, recovery, verification, settings — all four reused verbatim elsewhere in `portal/auth/*`.
 */
function makeSchema(t: (key: string) => string) {
  return z
    .object({
      tenantSlug: z
        .string()
        .trim()
        .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, t('errors.tenantSlugInvalid')),
      name: z.string().trim().min(2, t('errors.nameTooShort')).max(256, t('errors.nameTooLong')),
      email: z.string().trim().email(t('errors.emailInvalid')),
      password: z
        .string()
        .min(8, t('errors.passwordTooShort'))
        .max(72, t('errors.passwordTooLong'))
        .regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, t('errors.passwordComplexity')),
      confirmPassword: z.string(),
    })
    .refine((values) => values.password === values.confirmPassword, {
      message: t('errors.passwordMismatch'),
      path: ['confirmPassword'],
    });
}

type Values = z.infer<ReturnType<typeof makeSchema>>;

const emptyForm: Values = { tenantSlug: '', name: '', email: '', password: '', confirmPassword: '' };

export default function PortalRegisterPage() {
  const t = useTranslations('portal');
  const [registered, setRegistered] = useState(false);
  const schema = makeSchema((key) => t(`auth.register.${key}`));
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: emptyForm });

  const onSubmit = async (values: Values) => {
    try {
      await portalApi.post('/portal/auth/register', {
        tenantSlug: values.tenantSlug,
        name: values.name,
        email: values.email,
        password: values.password,
      });
      setRegistered(true);
    } catch (error) {
      const message = error instanceof ApiRequestError ? error.message : t('auth.register.error');
      form.setError('email', { message });
    }
  };

  if (registered) {
    return (
      <Card className="border-border/50">
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <CheckCircle2 className="h-10 w-10 text-primary" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">{t('auth.register.checkEmail')}</p>
          <Link href="/portal/auth/login" className="text-sm underline">
            {t('auth.register.signIn')}
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border/50">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl font-bold">{t('auth.register.title')}</CardTitle>
        <CardDescription>{t('auth.register.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Form {...form}>
          <form
            onSubmit={(event) => {
              void form.handleSubmit(onSubmit)(event);
            }}
            className="space-y-4"
          >
            <FormField
              control={form.control}
              name="tenantSlug"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('auth.register.tenantSlugLabel')}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="acme" autoComplete="off" />
                  </FormControl>
                  <FormDescription>{t('auth.register.tenantSlugDescription')}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('auth.register.nameLabel')}</FormLabel>
                  <FormControl>
                    <Input {...field} autoComplete="name" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('auth.register.emailLabel')}</FormLabel>
                  <FormControl>
                    <Input {...field} type="email" autoComplete="email" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('auth.register.passwordLabel')}</FormLabel>
                  <FormControl>
                    <Input {...field} type="password" autoComplete="new-password" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="confirmPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('auth.register.confirmPasswordLabel')}</FormLabel>
                  <FormControl>
                    <Input {...field} type="password" autoComplete="new-password" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? t('auth.register.creating') : t('auth.register.submit')}
            </Button>
          </form>
        </Form>
        <p className="text-center text-sm text-muted-foreground">
          {t('auth.register.alreadyHaveAccount')}{' '}
          <Link href="/portal/auth/login" className="underline">
            {t('auth.register.signIn')}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
