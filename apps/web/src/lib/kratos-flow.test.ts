import { describe, expect, it } from 'vitest';
import type { UiContainer, UiNodeInputAttributesTypeEnum } from '@ory/client-fetch';
import { buildSubmitBody, classifyFlowResponse, parseFlowUi } from './kratos-flow';
import type { InputNode } from './kratos-flow';

/**
 * Regression suite for two bugs that shipped together in `KratosFlowForm`:
 *
 *  1. `if (res.ok) onSuccess()` — the `code` flows (recovery + verification, `use: code` in
 *     kratos.yml) answer HTTP 200 at step 1 too, so the verification page announced "Your email
 *     address has been verified" the moment the user submitted their address, and recovery
 *     redirected to settings with no privileged session and no way to enter the code.
 *  2. The submit body was built from a snapshot taken when the form mounted, so a field that only
 *     exists from step 2 on — the hidden `method: code` — was never sent and "Resend code" 400'd.
 *
 * Every body below is a real response captured from the running Kratos v26.2.0.
 */
const ui = (nodes: unknown[] = []): UiContainer =>
  ({ action: 'http://localhost:33012/self-service/recovery?flow=1', method: 'POST', nodes }) as UiContainer;

function input(name: string, type: UiNodeInputAttributesTypeEnum, value?: unknown): InputNode {
  return {
    type: 'input',
    group: 'default',
    messages: [],
    meta: {},
    attributes: { name, type, value, disabled: false, node_type: 'input' },
  };
}

describe('classifyFlowResponse', () => {
  it('treats recovery step 1 (200 + sent_email) as a further step, not completion', () => {
    expect(classifyFlowResponse(200, { id: 'f', state: 'sent_email', ui: ui() })).toEqual({
      kind: 'update',
      ui: ui(),
    });
  });

  it('treats a 200 with no state as a further step rather than guessing completion', () => {
    expect(classifyFlowResponse(200, { id: 'f', ui: ui() }).kind).toBe('update');
  });

  it('completes a verification flow only once it reports passed_challenge', () => {
    expect(classifyFlowResponse(200, { id: 'f', state: 'passed_challenge', ui: ui() }).kind).toBe('done');
  });

  it('completes a settings flow on state success', () => {
    expect(classifyFlowResponse(200, { id: 'f', state: 'success', ui: ui() }).kind).toBe('done');
  });

  it('completes a login, whose 200 body carries a session and no ui at all', () => {
    expect(classifyFlowResponse(200, { session: { id: 's', active: true }, continue_with: null }).kind).toBe('done');
  });

  it('re-renders a 400 validation response as a flow update', () => {
    expect(classifyFlowResponse(400, { id: 'f', state: 'choose_method', ui: ui() }).kind).toBe('update');
  });

  it('treats registration step 1 (400 + choose_method) as the step it is, not a failure', () => {
    // Registration is two-step as well: submitting `method: profile` with the traits answers 400
    // and "Please choose a credential to authenticate yourself with", carrying the password field.
    expect(classifyFlowResponse(400, { id: 'f', state: 'choose_method', ui: ui() })).toEqual({
      kind: 'update',
      ui: ui(),
    });
  });

  it('completes a registration, whose 200 body carries an identity and no ui', () => {
    expect(classifyFlowResponse(200, { identity: { id: 'i' }, continue_with: [] }).kind).toBe('done');
  });

  it('follows the 422 browser_location_change_required that ends a code recovery', () => {
    expect(
      classifyFlowResponse(422, {
        error: { id: 'browser_location_change_required', code: 422 },
        redirect_browser_to: 'http://localhost:33000/auth/settings?flow=c15986c3',
      }),
    ).toEqual({ kind: 'redirect', url: 'http://localhost:33000/auth/settings?flow=c15986c3' });
  });

  it('offers the replacement flow Kratos minted when the old one expired (410)', () => {
    expect(
      classifyFlowResponse(410, {
        error: { id: 'self_service_flow_expired', code: 410 },
        expired_at: '2026-09-20T15:45:41Z',
        use_flow_id: 'e36f0d30-0a77-402a-b377-1704199cd850',
      }),
    ).toEqual({ kind: 'expired', flowId: 'e36f0d30-0a77-402a-b377-1704199cd850' });
  });

  it('reads the 303 restart of an expired recovery/verification flow as an expiry', () => {
    // `redirect: 'manual'` turns that 303 into an opaque response: status 0, no readable body.
    expect(classifyFlowResponse(0, null, true)).toEqual({ kind: 'expired', flowId: null });
  });

  it('reports a non-JSON or unrenderable failure instead of a blank form', () => {
    expect(classifyFlowResponse(502, null)).toEqual({ kind: 'failed', status: 502 });
  });
});

describe('parseFlowUi', () => {
  it('accepts a real flow body', () => {
    expect(parseFlowUi({ id: 'f', ui: ui() })).toEqual(ui());
  });

  it.each([
    ['a null body (res.json() failed)', null],
    ['a body with no ui', { id: 'f', state: 'success' }],
    ['a ui with no nodes array', { ui: { action: 'x', method: 'POST' } }],
  ])('rejects %s', (_label, body) => {
    expect(parseFlowUi(body)).toBeNull();
  });
});

describe('buildSubmitBody', () => {
  // Recovery step 2, exactly as Kratos returns it: the flow id never changes between steps, so the
  // form is never remounted — the hidden `method` below only reaches the wire if the body is built
  // from the CURRENT nodes.
  const step2 = [
    input('csrf_token', 'hidden', 'fresh-token'),
    input('code', 'text'),
    input('method', 'hidden', 'code'),
    input('method', 'submit', 'code'),
    input('email', 'submit', 'user@example.com'),
  ];

  it('sends the hidden method that only appears at step 2, so "Resend code" is not a 400', () => {
    const resendButton = step2[4];
    expect(buildSubmitBody(step2, { email: 'user@example.com' }, resendButton)).toEqual({
      csrf_token: 'fresh-token',
      method: 'code',
      email: 'user@example.com',
    });
  });

  it('submits the typed code with the clicked method', () => {
    expect(buildSubmitBody(step2, { code: '730871' }, step2[3])).toEqual({
      csrf_token: 'fresh-token',
      code: '730871',
      method: 'code',
    });
  });

  it('uses the freshest csrf token from the node, not the one the form mounted with', () => {
    expect(buildSubmitBody([input('csrf_token', 'hidden', 'rotated')], {}, undefined)).toEqual({
      csrf_token: 'rotated',
    });
  });

  // Registration step 2, as Kratos returns it: the traits the user typed at step 1 come back as
  // HIDDEN nodes carrying their values, alongside the password field that only exists from here on.
  // Same flow id as step 1, so again nothing remounts.
  const registrationStep2 = [
    input('csrf_token', 'hidden', 'rotated-token'),
    input('traits.email', 'hidden', 'new@example.com'),
    input('password', 'password'),
    input('traits.name', 'hidden', 'New User'),
    input('method', 'submit', 'password'),
    input('screen', 'submit', 'previous'),
  ];

  it('submits the traits that became hidden at registration step 2, with the typed password', () => {
    const edits = { 'traits.email': 'new@example.com', 'traits.name': 'New User', password: 'hunter2hunter2' };
    expect(buildSubmitBody(registrationStep2, edits, registrationStep2[4])).toEqual({
      csrf_token: 'rotated-token',
      traits: { email: 'new@example.com', name: 'New User' },
      password: 'hunter2hunter2',
      method: 'password',
    });
  });

  it('carries the traits back when registration step 2 is left via "Back"', () => {
    // Nothing typed this render — the values have to come from the hidden nodes alone.
    expect(buildSubmitBody(registrationStep2, {}, registrationStep2[5])).toEqual({
      csrf_token: 'rotated-token',
      traits: { email: 'new@example.com', name: 'New User' },
      screen: 'previous',
    });
  });

  it('nests dotted names and prefers what the user typed over the node default', () => {
    const nodes = [input('traits.email', 'email', 'old@example.com'), input('traits.name', 'text', 'Old Name')];
    expect(buildSubmitBody(nodes, { 'traits.email': 'new@example.com' }, undefined)).toEqual({
      traits: { email: 'new@example.com', name: 'Old Name' },
    });
  });

  it('omits an untouched valueless field — an empty password must stay out of a profile update', () => {
    const nodes = [input('traits.name', 'text', 'Admin'), input('password', 'password')];
    expect(buildSubmitBody(nodes, {}, input('method', 'submit', 'profile'))).toEqual({
      traits: { name: 'Admin' },
      method: 'profile',
    });
  });
});
