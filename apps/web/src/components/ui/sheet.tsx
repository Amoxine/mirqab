'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { SheetContent as BaseSheetContent } from '@open-gateway/ui';

export {
  Sheet,
  SheetClose,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
} from '@open-gateway/ui';

/** The shared SheetContent with the app's translated "Close" label for its corner button. */
export const SheetContent = React.forwardRef<
  React.ComponentRef<typeof BaseSheetContent>,
  React.ComponentPropsWithoutRef<typeof BaseSheetContent>
>((props, ref) => {
  const t = useTranslations('common');
  return <BaseSheetContent ref={ref} closeLabel={t('close')} {...props} />;
});
SheetContent.displayName = 'SheetContent';
