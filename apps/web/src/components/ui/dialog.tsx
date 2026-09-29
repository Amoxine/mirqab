'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { DialogContent as BaseDialogContent } from '@open-gateway/ui';

export {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from '@open-gateway/ui';

/** The shared DialogContent with the app's translated "Close" label for its corner button. */
export const DialogContent = React.forwardRef<
  React.ComponentRef<typeof BaseDialogContent>,
  React.ComponentPropsWithoutRef<typeof BaseDialogContent>
>((props, ref) => {
  const t = useTranslations('common');
  return <BaseDialogContent ref={ref} closeLabel={t('close')} {...props} />;
});
DialogContent.displayName = 'DialogContent';
