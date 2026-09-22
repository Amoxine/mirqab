'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/sonner';

interface KeyCreatedDialogProps {
  /** The raw key, held in memory by the caller only. `null` closes the dialog. */
  keyValue: string | null;
  onClose: () => void;
}

/** Shows the raw key exactly once, right after creation. */
export function KeyCreatedDialog({ keyValue, onClose }: KeyCreatedDialogProps) {
  const t = useTranslations('keys');
  const tCommon = useTranslations('common');
  const [copied, setCopied] = useState(false);

  const handleClose = () => {
    setCopied(false);
    onClose();
  };

  const handleCopy = async () => {
    if (keyValue === null) return;
    try {
      await navigator.clipboard.writeText(keyValue);
      setCopied(true);
    } catch {
      toast.error(t('createdDialog.copyFailed'));
    }
  };

  return (
    <Dialog open={keyValue !== null} onOpenChange={(open) => {
        if (!open) handleClose();
      }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('createdDialog.title')}</DialogTitle>
          <DialogDescription>{t('createdDialog.description')}</DialogDescription>
        </DialogHeader>
        <code
          data-testid="created-key-value"
          className="block select-all break-all rounded-md bg-muted p-3 text-sm"
        >
          {keyValue}
        </code>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="outline" onClick={handleCopy}>
            {copied ? <Check className="me-2 h-4 w-4" /> : <Copy className="me-2 h-4 w-4" />}
            {copied ? t('createdDialog.copied') : t('createdDialog.copy')}
          </Button>
          <Button type="button" onClick={handleClose}>
            {tCommon('done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
