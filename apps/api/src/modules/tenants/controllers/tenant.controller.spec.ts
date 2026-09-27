import 'reflect-metadata';
import { ForbiddenException, ValidationPipe } from '@nestjs/common';
import type { ArgumentMetadata, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AUDIT_KEY, type AuditMeta } from '../../../common/decorators/audit.decorator';
import { PERMISSIONS_KEY } from '../../../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import type { UserPayload } from '../../../common/types';
import { ASSIGNABLE_ROLES } from '../dto/assign-user.dto';
import { InviteByEmailDto } from '../dto/invite-by-email.dto';
import { ListTenantUsersDto } from '../dto/list-tenant-users.dto';
import type { TenantService } from '../services/tenant.service';
import { TenantController } from './tenant.controller';

/**
 * The interceptor's action-string-to-AuditAction mapping is already covered generically in
 * audit-log.interceptor.spec.ts (`'resource:suffix'` -> `SUFFIX`, proven with an arbitrary string).
 * What was missing — the actual gap this WP closes — is that `TenantController` carried no `@Audit`
 * metadata at all on any mutation, so nothing the interceptor already knows how to handle ever fired
 * for a tenant/membership change. This asserts every mutation IS wired, and specifically that
 * `updateMemberRole` maps to `ROLE_CHANGED` (WP21's named acceptance).
 */
describe('TenantController — @Audit wiring (WP21)', () => {
  const auditOf = (methodName: keyof TenantController): AuditMeta | undefined =>
    Reflect.getMetadata(AUDIT_KEY, TenantController.prototype[methodName] as object) as AuditMeta | undefined;

  it.each([
    ['create', 'tenant:created'],
    ['update', 'tenant:updated'],
    ['archive', 'tenant:deleted'],
    ['assignUser', 'tenant:assigned'],
    // V1-USR-01: still "a user got assigned to a tenant", just for someone with no account yet.
    ['inviteByEmail', 'tenant:assigned'],
    ['updateMemberRole', 'tenant:role_changed'],
    ['removeMember', 'tenant:unassigned'],
    // WP19 (U13/U14).
    ['setQuota', 'tenant:quota_updated'],
    ['resetQuota', 'tenant:quota_reset'],
  ] as const)('%s carries @Audit(%s)', (methodName, expectedAction) => {
    expect(auditOf(methodName)?.action).toBe(expectedAction);
  });

  // The interceptor derives the AuditAction enum value by uppercasing everything after the last
  // colon — assert the actual string this WP added resolves to the enum value it is named for.
  it("updateMemberRole's action suffix resolves to the ROLE_CHANGED enum value", () => {
    const action = auditOf('updateMemberRole')?.action ?? '';
    expect(action.split(':').pop()?.toUpperCase()).toBe('ROLE_CHANGED');
  });
});

/** A request context for `handler`, the way Nest hands one to a guard. */
function contextFor(handler: object, user: Pick<UserPayload, 'roles' | 'permissions'>): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => TenantController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

// V1-USR-01 / AC-USR01.2e. The ROUTE gate — the session's `user:create`. A different check from the
// service's Keto `manage` on the tenant being acted on (AC-USR01.2f, tenant.service.spec.ts): this one
// stops a caller whose role lacks the permission, that one re-anchors the decision on the `:id`.
describe('TenantController — POST :id/users/invite route permission', () => {
  // Reflect.get, not `prototype.inviteByEmail`: the handler is only a metadata carrier here, never called.
  const handlerOf = (name: keyof TenantController): object => Reflect.get(TenantController.prototype, name) as object;
  const invite = handlerOf('inviteByEmail');
  const guard = new PermissionsGuard(new Reflector());

  it('requires user:create — the same permission as POST :id/users, no new one', () => {
    expect(Reflect.getMetadata(PERMISSIONS_KEY, invite)).toEqual(['user:create']);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, invite)).toEqual(
      Reflect.getMetadata(PERMISSIONS_KEY, handlerOf('assignUser')),
    );
  });

  it('is behind PermissionsGuard (controller-level)', () => {
    expect(Reflect.getMetadata('__guards__', TenantController) as unknown[]).toContain(PermissionsGuard);
  });

  it('403s a caller without user:create, even one holding user:read', () => {
    const run = () => guard.canActivate(contextFor(invite, { roles: ['viewer'], permissions: ['user:read'] }));
    expect(run).toThrow(ForbiddenException);
    expect(run).toThrow('Missing permissions: user:create');
  });

  it('lets a caller holding user:create through to the service', () => {
    expect(guard.canActivate(contextFor(invite, { roles: ['admin'], permissions: ['user:create'] }))).toBe(true);
  });
});

// Owner decision on security-v1 H1: the route ships OFF. Proven over real HTTP, both ways — off it is
// the router's own 404 before any guard runs, on it goes through the guards to the real handler.
describe('TenantController — POST :id/users/invite behind FEATURE_INVITE_BY_EMAIL', () => {
  const TENANT = '6f1d2c3b-4a59-4e87-9b0c-1d2e3f4a5b6c';
  const PATH = `/tenants/${TENANT}/users/invite`;
  const original = process.env.FEATURE_INVITE_BY_EMAIL;

  afterEach(() => {
    if (original === undefined) delete process.env.FEATURE_INVITE_BY_EMAIL;
    else process.env.FEATURE_INVITE_BY_EMAIL = original;
  });

  /**
   * POSTs an invite to a real Nest HTTP app around TenantController, loaded fresh with the flag at
   * `flag`. A spy stands in for the global JwtAuthGuard: it records that a guard ran, then signs the
   * caller in holding `permissions`.
   */
  async function postInvite(flag: string | undefined, permissions: string[]) {
    if (flag === undefined) delete process.env.FEATURE_INVITE_BY_EMAIL;
    else process.env.FEATURE_INVITE_BY_EMAIL = flag;
    const guardRan = jest.fn();
    const inviteByEmail = jest.fn().mockResolvedValue({ userId: 'u-new', pending: true });
    const response = { status: 0, body: undefined as unknown };

    // A fresh module registry: the flag is read when tenant.controller.ts is evaluated, and every Nest
    // class the app touches must come from that same registry, or DI can't match its tokens.
    await jest.isolateModulesAsync(async () => {
      const { Test } = await import('@nestjs/testing');
      const { APP_GUARD } = await import('@nestjs/core');
      const { TenantController: Controller } = await import('./tenant.controller');
      const { TenantService: Service } = await import('../services/tenant.service');
      const moduleRef = await Test.createTestingModule({
        controllers: [Controller],
        providers: [
          { provide: Service, useValue: { inviteByEmail } },
          {
            provide: APP_GUARD,
            useValue: {
              canActivate: (ctx: ExecutionContext) => {
                guardRan();
                ctx.switchToHttp().getRequest<{ user?: unknown }>().user = {
                  sub: 'u1',
                  roles: ['admin'],
                  permissions,
                  tenantId: TENANT,
                };
                return true;
              },
            },
          },
        ],
      }).compile();
      const app = moduleRef.createNestApplication();
      await app.listen(0, '127.0.0.1');
      try {
        const res = await fetch(`${await app.getUrl()}${PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'bob@x.com', role: 'viewer' }),
        });
        response.status = res.status;
        response.body = (await res.json()) as unknown;
      } finally {
        await app.close();
      }
    });
    return { ...response, guardRan, inviteByEmail };
  }

  it.each([[undefined], ['false'], ['1']])(
    'FEATURE_INVITE_BY_EMAIL=%p: the same 404 as a path that does not exist, and no guard or service ever runs',
    async (flag) => {
      const res = await postInvite(flag, ['user:create']);

      expect(res.status).toBe(404);
      // Nest's router's own not-found body — not a NotFoundException from a handler that exists.
      expect(res.body).toEqual({ message: `Cannot POST ${PATH}`, error: 'Not Found', statusCode: 404 });
      expect(res.guardRan).not.toHaveBeenCalled();
      expect(res.inviteByEmail).not.toHaveBeenCalled();
    },
    30_000,
  );

  it('FEATURE_INVITE_BY_EMAIL=true: goes through the guards to the handler and answers 201', async () => {
    const res = await postInvite('true', ['user:create']);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, data: { userId: 'u-new', pending: true } });
    expect(res.guardRan).toHaveBeenCalled();
    expect(res.inviteByEmail).toHaveBeenCalledWith(TENANT, 'bob@x.com', 'viewer', expect.objectContaining({ sub: 'u1' }));
  }, 30_000);

  it('FEATURE_INVITE_BY_EMAIL=true: the permission guard is live — 403 without user:create', async () => {
    const res = await postInvite('true', ['user:read']);

    expect(res.status).toBe(403);
    expect(res.inviteByEmail).not.toHaveBeenCalled();
  }, 30_000);
});

/** The global pipe exactly as main.ts configures it. */
const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  transformOptions: { enableImplicitConversion: true },
});
const asBody = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({ type: 'body', metatype });
const asQuery = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({ type: 'query', metatype });

describe('TenantController — V1-USR-01 input contracts under the global ValidationPipe', () => {
  it('InviteByEmailDto accepts an email plus each assignable role', async () => {
    for (const role of ASSIGNABLE_ROLES) {
      await expect(pipe.transform({ email: 'Bob@X.com', role }, asBody(InviteByEmailDto))).resolves.toEqual({
        email: 'Bob@X.com',
        role,
      });
    }
  });

  it.each([
    ['a non-email', { email: 'not-an-email', role: 'viewer' }],
    ['super_admin', { email: 'a@b.c', role: 'super_admin' }],
    ['an unknown role', { email: 'a@b.c', role: 'owner' }],
    ['a smuggled userId', { email: 'a@b.c', role: 'viewer', userId: '6f1d2c3b-4a59-4e87-9b0c-1d2e3f4a5b6c' }],
  ])('InviteByEmailDto rejects %s', async (_label, body) => {
    await expect(pipe.transform(body, asBody(InviteByEmailDto))).rejects.toThrow();
  });

  it('ListTenantUsersDto takes page, pageSize and q together (query strings coerced to numbers)', async () => {
    await expect(
      pipe.transform({ page: '2', pageSize: '50', q: 'bob' }, asQuery(ListTenantUsersDto)),
    ).resolves.toMatchObject({ page: 2, pageSize: 50, q: 'bob' });
  });

  it.each([
    ['a pageSize over 100', { pageSize: '101' }],
    ['page 0', { page: '0' }],
    ['an over-long q', { q: 'x'.repeat(255) }],
    ['an unknown key', { tenantId: 'someone-else' }],
  ])('ListTenantUsersDto rejects %s', async (_label, query) => {
    await expect(pipe.transform(query, asQuery(ListTenantUsersDto))).rejects.toThrow();
  });
});

// The response shape apps/web's use-tenants.ts consumes — the same `{ success, data, meta }` envelope
// GET /tenants already sends.
describe('TenantController — V1-USR-01 handler wiring', () => {
  const user = { sub: 'u1', roles: ['admin'] } as unknown as UserPayload;
  const page = { data: [], meta: { page: 2, pageSize: 10, totalCount: 11, totalPages: 2 } };
  const pendingMember = { userId: 'u-new', email: 'bob@x.com', pending: true };
  const service = {
    findUsers: jest.fn().mockResolvedValue(page),
    inviteByEmail: jest.fn().mockResolvedValue(pendingMember),
  };
  const controller = new TenantController(service as unknown as TenantService);

  it('findUsers threads the query through and returns the paginated envelope', async () => {
    const query = Object.assign(new ListTenantUsersDto(), { page: 2, pageSize: 10, q: 'bob' });

    await expect(controller.findUsers('t1', query, user)).resolves.toEqual({ success: true, ...page });
    expect(service.findUsers).toHaveBeenCalledWith('t1', user, query);
  });

  it("inviteByEmail calls the service with the path's tenant and the body's email and role", async () => {
    const body = Object.assign(new InviteByEmailDto(), { email: 'Bob@X.com', role: 'viewer' as const });

    await expect(controller.inviteByEmail('t1', body, user)).resolves.toEqual({ success: true, data: pendingMember });
    expect(service.inviteByEmail).toHaveBeenCalledWith('t1', 'Bob@X.com', 'viewer', user);
  });
});
