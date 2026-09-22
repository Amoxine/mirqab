'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { UiContainer } from '@ory/client-fetch';
import { toast } from '@/components/ui/sonner';

/**
 * Every `createBrowser*Flow` call needs this. Without it Kratos answers flow init with a 303 to the
 * UI page instead of the flow JSON, and the browser's own fetch then follows that redirect back to
 * this origin — still in CORS mode, against a Next page that has no `Access-Control-Allow-Origin`,
 * so it fails and the page reports it could not start the flow. The generated client sets no Accept
 * header on those five methods (it does on `get*Flow`), so each call site supplies it.
 */
export const ACCEPT_JSON: RequestInit = { headers: { Accept: 'application/json' } };

/**
 * The scaffold all five `(auth)/auth/*` pages share: read `?flow=`, load that Kratos flow (or start
 * a fresh one), and hand back exactly what `KratosFlowForm` needs. Pages differ only in WHICH flow
 * they load, which is the `load` argument — everything else was five byte-identical copies.
 *
 * The caller must still sit inside a `<Suspense>` boundary: `useSearchParams()` opts a page out of
 * static prerendering otherwise (Next's "missing-suspense-with-csr-bailout" build error).
 */
export function useKratosFlow<T extends { ui: UiContainer }>(
  load: (flowId: string | null) => Promise<T>,
  loadErrorMessage: string,
) {
  const flowId = useSearchParams().get('flow');
  const [flow, setFlow] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  // `load` is an inline arrow at every call site, so it is a new function on every render. Holding
  // it in a ref keeps the effect keyed on `flowId` alone — depending on `load` would start a brand
  // new flow on each render.
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let cancelled = false;
    loadRef
      .current(flowId)
      .then((result) => {
        if (!cancelled) setFlow(result);
      })
      .catch(() => {
        if (!cancelled) setError(loadErrorMessage);
      });
    return () => {
      cancelled = true;
    };
  }, [flowId, loadErrorMessage]);

  /** A flow update only ever changes the ui — the flow id is the same across every step. */
  const onFlowUpdate = useCallback((ui: UiContainer) => {
    setFlow((prev) => (prev ? { ...prev, ui } : prev));
  }, []);

  const onError = useCallback((message: string) => {
    toast.error(message);
  }, []);

  return { flow, error, setError, onFlowUpdate, onError };
}
