'use client';

import { useState } from 'react';
import type { SubmitEvent } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { UiContainer, UiText } from '@ory/client-fetch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { buildSubmitBody, classifyFlowResponse, isInputNode, isSubmitNode, nodeValue } from '@/lib/kratos-flow';
import type { InputNode } from '@/lib/kratos-flow';
import { sanitizeClientReturnTo } from '@/lib/return-to';
import { cn } from '@/lib/utils';

/**
 * Renders any Kratos self-service flow's `ui` container (login/registration/settings/recovery/
 * verification all share this shape) and submits it to `ui.action`. Kratos is headless — this is
 * the one generic renderer every `(auth)/auth/*` page uses instead of five hand-built forms.
 *
 * What a response MEANS lives in `@/lib/kratos-flow`, where it is unit-tested; this file is the
 * rendering and the navigation.
 */
interface KratosFlowFormProps {
  ui: UiContainer;
  /** Called only when the flow is genuinely over, with the parsed JSON body — its shape depends on
   * the flow type, which the caller already knows. A 2xx alone does NOT mean this. */
  onSuccess: (body: unknown) => void;
  /** Called with a further step, a resent code, or validation errors — the caller just re-renders. */
  onFlowUpdate: (ui: UiContainer) => void;
  /** Shown for a failure the flow response can't explain itself. */
  onError: (message: string) => void;
}

const isVisible = (node: InputNode) => node.attributes.type !== 'hidden';

function messageTextClass(type: UiText['type']): string {
  return type === 'error' ? 'text-destructive' : 'text-muted-foreground';
}

export function KratosFlowForm({ ui, onSuccess, onFlowUpdate, onError }: KratosFlowFormProps) {
  const t = useTranslations('auth');
  const router = useRouter();
  const pathname = usePathname();
  const inputNodes = ui.nodes.filter(isInputNode);
  /**
   * Only what the user typed. Every other value is read from the CURRENT `ui` at submit time —
   * a flow keeps its id across steps, so this component is never remounted, and a mount-time
   * snapshot would permanently miss any field a later step introduces.
   */
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const submit = async (clicked: InputNode | undefined) => {
    setSubmitting(true);
    try {
      const res = await fetch(ui.action, {
        method: ui.method,
        credentials: 'include',
        // `manual` so an expired recovery/verification flow — which Kratos answers with a 303 back
        // to this page — is visible as a redirect instead of a CORS failure. See classifyFlowResponse.
        redirect: 'manual',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(buildSubmitBody(inputNodes, edits, clicked)),
      });

      const data: unknown = await res.json().catch(() => null);
      const outcome = classifyFlowResponse(res.status, data, res.type === 'opaqueredirect');
      switch (outcome.kind) {
        case 'redirect':
          // Kratos-issued and checked against `allowed_return_urls` — with Go's net/url, which can
          // disagree with the WHATWG parser this assign() actually resolves it with. Re-sanitize for
          // the parser that matters (see sanitizeClientReturnTo). A full navigation, not
          // router.push(): the response that carried this URL also set the session cookie the
          // destination depends on (this is how a code recovery hands off to a settings flow).
          window.location.assign(sanitizeClientReturnTo(outcome.url));
          return;
        case 'expired':
          // A 10m flow lifespan runs out routinely, and every one of these pages loads `?flow=`, so
          // when Kratos names the replacement it made, land the user on it — a soft navigation, so
          // the toast explaining what happened survives. When it doesn't name one (the 303 restart),
          // reload the page bare, which starts a fresh flow: silent, but a working form beats the
          // toast that every retry used to reproduce.
          if (outcome.flowId) {
            onError(t('flowForm.expired'));
            router.replace(`${pathname}?flow=${encodeURIComponent(outcome.flowId)}`);
          } else {
            window.location.replace(pathname);
          }
          return;
        case 'update':
          onFlowUpdate(outcome.ui);
          return;
        case 'done':
          onSuccess(data);
          return;
        case 'failed':
          onError(t('flowForm.requestFailed', { status: outcome.status }));
          return;
      }
    } catch {
      onError(t('flowForm.networkError'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Enter-key submission with no button explicitly clicked defaults to the first submit node,
    // mirroring native HTML form behaviour.
    void submit(inputNodes.find(isSubmitNode));
  };

  const messageNodes = ui.nodes.filter((n) => !isInputNode(n) || isVisible(n));

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {ui.messages?.map((m) => (
        // Errors are announced: they replace nothing visible, so a screen reader would miss them.
        <p key={m.id} role={m.type === 'error' ? 'alert' : undefined} className={cn('text-sm', messageTextClass(m.type))}>
          {m.text}
        </p>
      ))}

      {messageNodes.map((node, index) => {
        if (isInputNode(node)) {
          const attrs = node.attributes;
          if (isSubmitNode(node)) return null; // rendered separately, below
          const fieldId = `kratos-${attrs.name}`;
          const messagesId = `${fieldId}-messages`;
          const hasError = node.messages.some((m) => m.type === 'error');
          const value = nodeValue(attrs, edits) ?? '';
          return (
            <div key={attrs.name} className="space-y-1.5">
              {attrs.type !== 'checkbox' && node.meta.label && (
                <Label htmlFor={fieldId}>{node.meta.label.text}</Label>
              )}
              <div className={attrs.type === 'checkbox' ? 'flex items-center gap-2' : undefined}>
                <Input
                  id={fieldId}
                  type={attrs.type === 'checkbox' ? 'checkbox' : attrs.type}
                  name={attrs.name}
                  disabled={attrs.disabled || submitting}
                  required={attrs.required}
                  autoComplete={attrs.autocomplete}
                  aria-invalid={hasError || undefined}
                  aria-describedby={node.messages.length > 0 ? messagesId : undefined}
                  checked={attrs.type === 'checkbox' ? value === 'true' : undefined}
                  value={attrs.type === 'checkbox' ? undefined : value}
                  className={attrs.type === 'checkbox' ? 'size-5 shrink-0 cursor-pointer accent-primary' : undefined}
                  onChange={(e) => {
                    setEdits((prev) => ({
                      ...prev,
                      [attrs.name]: attrs.type === 'checkbox' ? String(e.target.checked) : e.target.value,
                    }));
                  }}
                />
                {attrs.type === 'checkbox' && node.meta.label && (
                  <Label htmlFor={fieldId} className="font-normal">
                    {node.meta.label.text}
                  </Label>
                )}
              </div>
              {node.messages.length > 0 && (
                <div id={messagesId} className="space-y-1">
                  {node.messages.map((m) => (
                    <p key={m.id} className={cn('text-sm', messageTextClass(m.type))}>
                      {m.text}
                    </p>
                  ))}
                </div>
              )}
            </div>
          );
        }
        if (node.type === 'text' && node.attributes.node_type === 'text') {
          // e.g. a recovery code shown back to the user.
          return (
            <p key={`text-${String(index)}`} className="rounded-md border bg-muted p-3 text-sm">
              {node.attributes.text.text}
            </p>
          );
        }
        if (node.type === 'img' && node.attributes.node_type === 'img') {
          // eslint-disable-next-line @next/next/no-img-element -- a Kratos-hosted QR/TOTP image, not a static asset Next can optimise.
          return <img key={`img-${String(index)}`} src={node.attributes.src} alt="" className="mx-auto" />;
        }
        // `a`, `script` and `div` nodes are unreachable while only `password` + `code` are enabled
        // (kratos.yml `selfservice.methods`) — but enabling oidc/passkey/webauthn/totp would make
        // them appear, and dropping them silently would look like a missing field, not a gap here.
        if (process.env.NODE_ENV !== 'production') {
          console.warn(
            `[KratosFlowForm] no renderer for a "${node.type}" node in group "${node.group}" — it was not displayed.`,
          );
        }
        return null;
      })}

      <div className="flex flex-col gap-2">
        {inputNodes.filter(isSubmitNode).map((node) => (
          <Button
            key={node.attributes.name + String(node.attributes.value)}
            type="submit"
            variant={node.attributes.name === 'method' && node.attributes.value === 'password' ? 'default' : 'outline'}
            loading={submitting}
            disabled={node.attributes.disabled}
            onClick={(e) => {
              e.preventDefault();
              void submit(node);
            }}
          >
            {node.meta.label?.text ?? t('flowForm.submit')}
          </Button>
        ))}
      </div>
    </form>
  );
}
