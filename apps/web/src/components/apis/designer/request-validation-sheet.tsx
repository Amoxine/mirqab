'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm, type Control, type Resolver } from 'react-hook-form';
import { z } from 'zod';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/sonner';
import { useUpdateApi, type ApiDefinition } from '@/hooks/use-apis';
import { ConfigSheet, ConfigSheetFooter } from './config-sheet';

type Translate = (key: string) => string;

/** Blank -> `null` (clears validation). Non-blank must be valid JSON and a plain object — a JSON
 * Schema is always an object, and the gateway rejects the request body against it (422). */
function makeSchema(t: Translate) {
  return z.object({
    schema: z.string().transform((text, ctx) => {
      if (text.trim() === '') return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('designer.requestValidation.invalidJson') });
        return z.NEVER;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('designer.requestValidation.mustBeObject') });
        return z.NEVER;
      }
      return parsed as Record<string, unknown>;
    }),
  });
}

type Input_ = z.input<ReturnType<typeof makeSchema>>;
type Values = z.infer<ReturnType<typeof makeSchema>>;

function toFormInput(api: ApiDefinition): Input_ {
  const schema = api.config?.validateRequestSchema;
  return { schema: schema ? JSON.stringify(schema, null, 2) : '' };
}

interface RequestValidationSheetProps {
  api: ApiDefinition;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** WP15c: a JSON Schema the request body must satisfy — a violation is rejected by the GATEWAY with
 * 422, so a malformed body never reaches the upstream. */
export function RequestValidationSheet({ api, open, onOpenChange }: RequestValidationSheetProps) {
  const t = useTranslations('apis');
  const updateMutation = useUpdateApi(api.id);
  const schema = makeSchema(t);
  const form = useForm<Input_, unknown, Values>({
    resolver: zodResolver(schema) as unknown as Resolver<Input_, unknown, Values>,
    defaultValues: toFormInput(api),
  });
  const control = form.control as unknown as Control<Input_>;

  const handleClose = () => {
    form.reset();
    onOpenChange(false);
  };

  const onSubmit = async (values: Values) => {
    try {
      await updateMutation.mutateAsync({ config: { validateRequestSchema: values.schema } });
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
      title={t('designer.requestValidation.title')}
      description={t('designer.requestValidation.description')}
    >
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col gap-4">
          <FormField
            control={control}
            name="schema"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('designer.requestValidation.schema')}</FormLabel>
                <FormControl>
                  <Textarea
                    {...field}
                    rows={10}
                    className="font-mono text-xs"
                    placeholder='{"type":"object","required":["id"]}'
                  />
                </FormControl>
                <FormDescription>{t('designer.requestValidation.schemaDescription')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <ConfigSheetFooter isSubmitting={form.formState.isSubmitting} onCancel={handleClose} />
        </form>
      </Form>
    </ConfigSheet>
  );
}
