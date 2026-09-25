import type { useTranslations } from 'next-intl';
import { toast } from '@/components/ui/sonner';
import { ApiRequestError } from '@/lib/api-client';

type Translate = ReturnType<typeof useTranslations>;

/** API codes with their own translated explanation; the server text adds nothing to these. */
const CODE_KEYS: Record<string, string> = {
  ENDPOINT_REVISION_STALE: 'staleRevision',
  SPEC_VERSION_STALE: 'specUpdate.stale',
  SPEC_REMOVES_GOVERNED_ENDPOINTS: 'specUpdate.removesGoverned',
};
const STATUS_KEYS = new Set([400, 403, 404, 409, 413, 415, 422]);

/**
 * An API failure as translated text. The server's own message is English (and may name a field or
 * a rule), so it is only ever the secondary, left-to-right `detail`, never the message itself.
 */
export function describeApiError(t: Translate, error: unknown, fallbackKey: string): { message: string; detail?: string } {
  if (!(error instanceof ApiRequestError)) return { message: t(fallbackKey) };
  const codeKey = error.code ? CODE_KEYS[error.code] : undefined;
  if (codeKey) return { message: t(codeKey) };
  const message = STATUS_KEYS.has(error.status) ? t(`httpErrors.${String(error.status)}`) : t(fallbackKey);
  return { message, detail: error.message };
}

/** `describeApiError` as an error toast. `t` is the `openapi` namespace. */
export function toastApiError(t: Translate, error: unknown, fallbackKey: string): void {
  const { message, detail } = describeApiError(t, error, fallbackKey);
  if (detail) toast.error(message, { description: <span dir="ltr">{detail}</span> });
  else toast.error(message);
}

/** The same, inline (the import wizard shows a refused document in place). */
export function ApiErrorText({ message, detail }: { message: string; detail?: string }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="break-words">{message}</p>
      {detail && (
        <p dir="ltr" className="break-words text-xs text-muted-foreground">
          {detail}
        </p>
      )}
    </div>
  );
}
