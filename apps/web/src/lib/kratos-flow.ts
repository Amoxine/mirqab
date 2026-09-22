import type { UiContainer, UiNode, UiNodeInputAttributes } from '@ory/client-fetch';

/**
 * The two decisions `KratosFlowForm` gets wrong if it guesses — what a flow response MEANS, and
 * what a submit body must contain — kept pure and DOM-free so both are unit-testable.
 *
 * Every shape below was probed against the running Kratos v26.2.0 (infra/ory/kratos/kratos.yml),
 * not read off a type definition. See `kratos-flow.test.ts` for the captured responses.
 */

export type InputNode = UiNode & { attributes: UiNodeInputAttributes };

export const isInputNode = (node: UiNode): node is InputNode => node.attributes.node_type === 'input';
export const isSubmitNode = (node: InputNode): boolean =>
  node.attributes.type === 'submit' || node.attributes.type === 'button';

/**
 * The only two states that mean a flow is OVER:
 *  - `success`          — a settings update was saved (HTTP 200, body is the flow itself),
 *  - `passed_challenge` — a verification code was accepted (HTTP 200).
 *
 * `choose_method`, `sent_email` and `show_form` are all further steps — and Kratos serves those
 * with HTTP 200 as well, which is precisely why `res.ok` cannot be the completion test. Treating
 * step 1 of a `code` flow as completion is what told users their email was verified the instant
 * they typed it in.
 */
const TERMINAL_FLOW_STATES = new Set(['success', 'passed_challenge']);

export type FlowOutcome =
  /** HTTP 422 `browser_location_change_required`: Kratos wants the browser at this URL now. It is
   * how a `code` recovery ENDS — the hand-off to a privileged settings flow. */
  | { kind: 'redirect'; url: string }
  /** The flow outlived its 10m `lifespan`. Kratos says so two different ways: login/registration/
   * settings answer HTTP 410 naming the replacement flow it already created (`use_flow_id`), while
   * recovery/verification answer 303 to this same page carrying a new flow id — unreadable from a
   * cross-origin fetch, so `flowId` is null there and the page reloads into a fresh flow instead. */
  | { kind: 'expired'; flowId: string | null }
  /** A next step, a resent code, or validation errors — re-render with this ui. */
  | { kind: 'update'; ui: UiContainer }
  /** Genuinely finished: a login/registration session, a saved settings flow, a verified address. */
  | { kind: 'done' }
  /** Not a flow and not a success — a proxy's HTML error page, a 5xx, a bare GenericError. */
  | { kind: 'failed'; status: number };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * The flow ui out of a response body, or null if the body isn't one — the runtime check that keeps
 * a non-JSON or unexpected 200 from being cast into page state and rendering as a dead skeleton.
 */
export function parseFlowUi(body: unknown): UiContainer | null {
  const ui = asRecord(asRecord(body)?.ui);
  if (!ui || !Array.isArray(ui.nodes) || typeof ui.action !== 'string') return null;
  return ui as unknown as UiContainer;
}

/**
 * `opaqueRedirect` is `res.type === 'opaqueredirect'`, which only happens because the fetch asks for
 * `redirect: 'manual'`: Kratos restarts an expired recovery/verification flow with a 303 back to
 * this app's own page, and letting the browser follow that from a cross-origin fetch fails CORS
 * (a Next page serves no `Access-Control-Allow-Origin`), leaving the user on a "network error"
 * toast that every retry reproduces.
 */
export function classifyFlowResponse(status: number, body: unknown, opaqueRedirect = false): FlowOutcome {
  if (opaqueRedirect) return { kind: 'expired', flowId: null };

  const root = asRecord(body);

  const redirect = asString(root?.redirect_browser_to);
  if (redirect) return { kind: 'redirect', url: redirect };

  if (asString(asRecord(root?.error)?.id) === 'self_service_flow_expired') {
    return { kind: 'expired', flowId: asString(root?.use_flow_id) ?? null };
  }

  const ui = parseFlowUi(body);
  if (ui) {
    const state = asString(root?.state);
    return state !== undefined && TERMINAL_FLOW_STATES.has(state) ? { kind: 'done' } : { kind: 'update', ui };
  }

  // No flow to render. A completed login is `{ session, continue_with }` and a completed
  // registration `{ identity, ... }` — neither carries a ui, so here (and only here) 2xx is success.
  return status >= 200 && status < 300 ? { kind: 'done' } : { kind: 'failed', status };
}

/** `traits.email` -> `{ traits: { email: value } }` — Kratos's JSON body must be nested, not flat. */
function setDeep(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  const lastKey = keys.pop();
  if (lastKey === undefined) return; // `path` was empty — never happens for a real node name

  let obj = target;
  for (const key of keys) {
    const next = obj[key];
    obj[key] = typeof next === 'object' && next !== null ? next : {};
    obj = obj[key] as Record<string, unknown>;
  }
  obj[lastKey] = value;
}

/**
 * What to submit for one node: what the user typed, else whatever Kratos put in the node. Reading
 * the node itself (rather than a snapshot taken when the form first mounted) is what makes a field
 * that only appears from step 2 on — recovery/verification's hidden `method: code` — actually get
 * sent. Without it, "Resend code" posts no method and Kratos answers 400.
 *
 * `undefined` means "don't send this field at all", which is not the same as an empty string: the
 * settings flow's empty `password` field must stay out of a `method: profile` submit.
 */
export function nodeValue(attrs: UiNodeInputAttributes, edits: Record<string, string>): string | undefined {
  const edited = edits[attrs.name];
  if (edited !== undefined) return edited;
  return attrs.value == null ? undefined : String(attrs.value);
}

/** `clicked` is the submit node the user pressed — its own name/value picks the method. */
export function buildSubmitBody(
  nodes: InputNode[],
  edits: Record<string, string>,
  clicked: InputNode | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const node of nodes) {
    if (isSubmitNode(node)) continue;
    const value = nodeValue(node.attributes, edits);
    if (value !== undefined) setDeep(body, node.attributes.name, value);
  }
  if (clicked) setDeep(body, clicked.attributes.name, clicked.attributes.value);
  return body;
}
