'use client';

import { useId, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { z } from 'zod';
import type { Control, FieldValues, Path } from 'react-hook-form';
import { FileUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { MAX_SPEC_BYTES, specByteLength } from '@/lib/api/openapi';

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** The pasted or uploaded document: required, at most 5 MB (the API's own limit, checked again there). */
export const specSourceSchema = (t: Translate) =>
  z
    .string()
    .refine((s) => s.trim() !== '', t('source.required'))
    .refine((s) => specByteLength(s) <= MAX_SPEC_BYTES, t('source.tooLarge', { mb: MAX_SPEC_BYTES / 1024 / 1024 }));

/**
 * Upload OR paste: a file is read into the same text field the user can paste into, so there is one
 * value, one validation and one request body whichever way it arrived.
 */
export function SpecSourceField<T extends FieldValues>({
  control,
  name,
  disabled,
  onFileError,
}: {
  control: Control<T>;
  name: Path<T>;
  disabled?: boolean;
  onFileError: (message: string) => void;
}) {
  const t = useTranslations('openapi');
  const fileRef = useRef<HTMLInputElement>(null);
  const fileId = useId();
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{t('source.label')}</FormLabel>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              id={fileId}
              type="file"
              accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                if (file.size > MAX_SPEC_BYTES) {
                  onFileError(t('source.tooLarge', { mb: MAX_SPEC_BYTES / 1024 / 1024 }));
                  return;
                }
                // `File.text()` decodes UTF-8; a UTF-16 file reads as garbage (the help text says so).
                file.text().then(
                  (text) => {
                    field.onChange(text);
                  },
                  () => {
                    onFileError(t('source.readError'));
                  },
                );
              }}
            />
            <Button type="button" variant="outline" disabled={disabled} onClick={() => fileRef.current?.click()}>
              <FileUp className="h-4 w-4" aria-hidden="true" />
              {t('source.chooseFile')}
            </Button>
            <span className="text-sm text-muted-foreground">{t('source.orPaste')}</span>
          </div>
          <FormControl>
            <Textarea
              {...field}
              value={field.value}
              dir="ltr"
              rows={10}
              spellCheck={false}
              disabled={disabled}
              placeholder={t('source.placeholder')}
              className="max-h-80 font-mono text-xs"
            />
          </FormControl>
          <FormDescription>{t('source.help', { mb: MAX_SPEC_BYTES / 1024 / 1024 })}</FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
