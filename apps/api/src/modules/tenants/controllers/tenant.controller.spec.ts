import 'reflect-metadata';
import { AUDIT_KEY, type AuditMeta } from '../../../common/decorators/audit.decorator';
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
