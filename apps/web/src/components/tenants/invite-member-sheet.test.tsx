// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import T from '@/messages/en/tenants.json';
import C from '@/messages/en/common.json';
import { fail, mockFetch, ok, renderUi } from './test-utils';
import { InviteMemberSheet } from './invite-member-sheet';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock('@/components/ui/sonner', () => ({ toast }));

const FLAG = 'NEXT_PUBLIC_FEATURE_INVITE_BY_EMAIL';

function open() {
  const onOpenChange = vi.fn();
  renderUi(<InviteMemberSheet tenantId="t1" open onOpenChange={onOpenChange} />);
  return { onOpenChange, email: screen.getByLabelText(C.email) };
}

const submit = () => {
  fireEvent.click(screen.getByRole('button', { name: T.invite.submit }));
};

beforeEach(() => {
  vi.clearAllMocks();
  Reflect.deleteProperty(process.env, FLAG); // off by default, same as production until the owner turns it back on
});

afterEach(() => {
  Reflect.deleteProperty(process.env, FLAG);
});

describe('InviteMemberSheet — always available, regardless of the invite-by-email flag', () => {
  it('a found, not-yet-member user is assigned in one submit', async () => {
    const calls = mockFetch((call) => {
      if (call.path.includes('/users/lookup')) return ok({ id: 'u1', email: 'a@x.com', name: 'A', isMember: false });
      return ok({ userId: 'u1', email: 'a@x.com', name: 'A', role: 'viewer', isDefault: false, pending: false, createdAt: '' });
    });
    const { email, onOpenChange } = open();
    fireEvent.change(email, { target: { value: 'a@x.com' } });
    submit();
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(calls.some((c) => c.method === 'POST' && c.path === '/tenants/t1/users')).toBe(true);
    expect(toast.success).toHaveBeenCalledWith(T.invite.successToast.replace('{email}', 'a@x.com'));
  });

  it('an already-member match still refuses on the field, no invite call', async () => {
    mockFetch((call) => {
      if (call.path.includes('/users/lookup')) return ok({ id: 'u1', email: 'a@x.com', name: 'A', isMember: true });
      throw new Error(`unexpected call ${call.method} ${call.path}`);
    });
    const { email } = open();
    fireEvent.change(email, { target: { value: 'a@x.com' } });
    submit();
    expect(await screen.findByText(T.invite.alreadyMemberError)).toBeDefined();
  });
});

describe('InviteMemberSheet — NEXT_PUBLIC_FEATURE_INVITE_BY_EMAIL off (the default)', () => {
  it('no match falls back to the plain field error — no offer, no invite call', async () => {
    const calls = mockFetch((call) => {
      if (call.path.includes('/users/lookup')) return ok(null);
      throw new Error(`unexpected call ${call.method} ${call.path}`);
    });
    const { email } = open();
    fireEvent.change(email, { target: { value: 'new@x.com' } });
    submit();
    expect(await screen.findByText(T.invite.notFoundError)).toBeDefined();
    expect(screen.queryByRole('button', { name: T.invite.inviteSubmit })).toBeNull();
    expect(screen.queryByText(T.invite.offerText.replace('{email}', 'new@x.com'))).toBeNull();
    expect(calls.every((c) => c.path !== '/tenants/t1/users/invite')).toBe(true);
  });
});

describe('InviteMemberSheet — NEXT_PUBLIC_FEATURE_INVITE_BY_EMAIL on', () => {
  beforeEach(() => {
    process.env[FLAG] = 'true';
  });

  it('no match offers to invite by email instead of a dead-end error', async () => {
    mockFetch((call) => {
      if (call.path.includes('/users/lookup')) return ok(null);
      throw new Error(`unexpected call ${call.method} ${call.path}`);
    });
    const { email } = open();
    fireEvent.change(email, { target: { value: 'new@x.com' } });
    submit();
    expect(await screen.findByText(T.invite.offerText.replace('{email}', 'new@x.com'))).toBeDefined();
    expect(screen.getByRole('button', { name: T.invite.inviteSubmit })).toBeDefined();
  });

  it('confirming the offer calls the invite route, never Kratos/email, and the toast never implies one was sent', async () => {
    const calls = mockFetch((call) => {
      if (call.path.includes('/users/lookup')) return ok(null);
      if (call.method === 'POST' && call.path === '/tenants/t1/users/invite') {
        return ok({ userId: 'u2', email: 'new@x.com', name: 'new@x.com', role: 'viewer', isDefault: false, pending: true, createdAt: '' });
      }
      throw new Error(`unexpected call ${call.method} ${call.path}`);
    });
    const { email, onOpenChange } = open();
    fireEvent.change(email, { target: { value: 'new@x.com' } });
    submit();
    await screen.findByRole('button', { name: T.invite.inviteSubmit });
    fireEvent.click(screen.getByRole('button', { name: T.invite.inviteSubmit }));
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(calls[calls.length - 1]).toMatchObject({ method: 'POST', path: '/tenants/t1/users/invite' });
    expect(JSON.parse(calls[calls.length - 1]?.body ?? '{}')).toEqual({ email: 'new@x.com', role: 'viewer' });
    const successCall = toast.success.mock.calls[0]?.[0] as string;
    expect(successCall).not.toMatch(/we (sent|emailed)/i);
  });

  it('inviting an email already invited/a member maps the 409 to a field error, not a toast', async () => {
    mockFetch((call) => {
      if (call.path.includes('/users/lookup')) return ok(null);
      if (call.method === 'POST' && call.path === '/tenants/t1/users/invite') {
        return fail(409, 'conflict', 'CONFLICT');
      }
      throw new Error(`unexpected call ${call.method} ${call.path}`);
    });
    const { email } = open();
    fireEvent.change(email, { target: { value: 'dup@x.com' } });
    submit();
    await screen.findByRole('button', { name: T.invite.inviteSubmit });
    fireEvent.click(screen.getByRole('button', { name: T.invite.inviteSubmit }));
    expect(await screen.findByText(T.invite.alreadyInvitedError)).toBeDefined();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('editing the email after the offer clears it back to a fresh lookup', async () => {
    mockFetch((call) => {
      if (call.path.includes('/users/lookup')) return ok(null);
      throw new Error(`unexpected call ${call.method} ${call.path}`);
    });
    const { email } = open();
    fireEvent.change(email, { target: { value: 'new@x.com' } });
    submit();
    await screen.findByRole('button', { name: T.invite.inviteSubmit });
    fireEvent.change(email, { target: { value: 'new2@x.com' } });
    expect(screen.queryByRole('button', { name: T.invite.inviteSubmit })).toBeNull();
    expect(screen.getByRole('button', { name: T.invite.submit })).toBeDefined();
  });
});
