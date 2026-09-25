'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';

interface ConfigSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
}

/** Shared Sheet shell every Designer middleware form mounts inside — header, width, nothing else.
 * Each caller owns its own `<Form>` and submit handling. */
export function ConfigSheet({ open, onOpenChange, title, description, children }: ConfigSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        {children}
      </SheetContent>
    </Sheet>
  );
}

interface ConfigSheetFooterProps {
  isSubmitting: boolean;
  onCancel: () => void;
  /** Omit when this section has nothing meaningful to clear (e.g. a single required toggle). */
  onClear?: () => void;
}

/** Cancel / Clear section / Save — the same three actions on every Designer Sheet. */
export function ConfigSheetFooter({ isSubmitting, onCancel, onClear }: ConfigSheetFooterProps) {
  const t = useTranslations('apis');
  const tCommon = useTranslations('common');
  return (
    <SheetFooter className="mt-auto flex-col-reverse gap-2 pt-4 sm:flex-row sm:justify-between">
      {onClear ? (
        <Button type="button" variant="ghost" onClick={onClear} disabled={isSubmitting}>
          {t('designer.clearSection')}
        </Button>
      ) : (
        <span />
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
          {tCommon('cancel')}
        </Button>
        <Button type="submit" loading={isSubmitting}>
          {isSubmitting ? t('designer.saving') : tCommon('save')}
        </Button>
      </div>
    </SheetFooter>
  );
}
