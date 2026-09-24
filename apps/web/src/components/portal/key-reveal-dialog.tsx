'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/components/ui/sonner';

/** Shows a freshly-minted subscription key exactly once — same pattern as the dashboard's
 * OAuth2 `ClientSecretDialog` (`clients-tab.tsx`): the key only ever exists in this one response,
 * nothing stores it, and it is never fetched again. */
export function KeyRevealDialog({ keyValue, onClose }: { keyValue: string | null; onClose: () => void }) {
  const t = useTranslations('portal');
  const tCommon = useTranslations('common');
  const [copied, setCopied] = useState(false);

  return (
    <Dialog
      open={keyValue !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('key.dialogTitle')}</DialogTitle>
          <DialogDescription>{t('key.dialogDescription')}</DialogDescription>
        </DialogHeader>
        {keyValue && (
          <code className="block select-all break-all rounded-md bg-muted p-3 text-sm">{keyValue}</code>
        )}
        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              if (!keyValue) return;
              navigator.clipboard.writeText(keyValue).then(
                () => {
                  setCopied(true);
                },
                () => {
                  toast.error(t('key.copyError'));
                },
              );
            }}
          >
            {copied ? <Check className="me-2 h-4 w-4" /> : <Copy className="me-2 h-4 w-4" />}
            {copied ? t('key.copied') : t('key.copyKey')}
          </Button>
          <Button type="button" onClick={onClose}>
            {tCommon('done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
