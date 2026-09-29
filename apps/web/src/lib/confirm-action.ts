import { toast } from '@/components/ui/sonner';

interface ConfirmActionOptions<T> {
  /** The mutation. */
  run: () => Promise<T>;
  /** Toast text on success; omit for none (e.g. the result is shown in another dialog). */
  success?: (result: T) => string;
  /** Toast text when the error carries no message of its own. */
  failed: string;
  /** Closes the confirm dialog. */
  close: () => void;
  /** After a success, once the dialog is closed (navigate away, reveal a new secret…). */
  onDone?: (result: T) => void;
  /** Close the dialog on failure too (the server's message is already in the toast). Default: keep it open to retry. */
  closeOnError?: boolean;
}

/**
 * What every confirm dialog does after "Confirm": run the mutation, toast the outcome (the server's
 * own message on failure, since it names the reason — "last admin", "still has keys"), and close.
 */
export async function confirmAction<T>({
  run,
  success,
  failed,
  close,
  onDone,
  closeOnError = false,
}: ConfirmActionOptions<T>): Promise<void> {
  try {
    const result = await run();
    if (success) toast.success(success(result));
    close();
    onDone?.(result);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : failed);
    if (closeOnError) close();
  }
}
