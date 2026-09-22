import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ASSIGNABLE_ROLES, AssignUserDto } from './assign-user.dto';
import { UpdateMemberRoleDto } from './update-member-role.dto';

const USER_ID = '6f1d2c3b-4a59-4e87-9b0c-1d2e3f4a5b6c';

const invalidProps = async (
  cls: typeof AssignUserDto | typeof UpdateMemberRoleDto,
  body: Record<string, unknown>,
): Promise<string[]> => (await validate(plainToInstance(cls, body))).map((e) => e.property);

/**
 * The privilege-escalation regression these two DTOs exist to stop.
 *
 * `super_admin` used to be in ASSIGNABLE_ROLES, so `POST /tenants/:id/users` and
 * `PATCH /tenants/:id/users/:userId` accepted it. Both endpoints only require membership of the
 * tenant being edited (TenantService#assertMember), so any tenant admin could grant `super_admin` to
 * a second account inside their own tenant — and `super_admin` is a role-name-only bypass
 * (isSuperAdmin in common/types), not a tenant-scoped one. The granted account then passed every
 * PermissionsGuard check installation-wide, including `tenant:delete` and `role:delete`, which the
 * granting admin's own role is explicitly denied.
 *
 * The global ValidationPipe (main.ts) runs these validators, so an @IsIn rejection is a 400 on the
 * real endpoints, not just a unit-test detail.
 */
describe('tenant member-role DTOs reject super_admin', () => {
  it.each([
    ['AssignUserDto', AssignUserDto, { userId: USER_ID, role: 'super_admin' }, 'role'],
    ['UpdateMemberRoleDto', UpdateMemberRoleDto, { role: 'super_admin' }, 'role'],
  ])('%s rejects it', async (_label, cls, body, property) => {
    expect(await invalidProps(cls, body)).toEqual([property]);
  });

  it('is not merely absent from the list — ASSIGNABLE_ROLES must never regrow it', () => {
    expect(ASSIGNABLE_ROLES).toEqual(['admin', 'operator', 'viewer']);
    expect(ASSIGNABLE_ROLES as readonly string[]).not.toContain('super_admin');
  });

  it('still accepts the three roles a tenant admin may legitimately hand out', async () => {
    for (const role of ASSIGNABLE_ROLES) {
      expect(await invalidProps(AssignUserDto, { userId: USER_ID, role })).toEqual([]);
      expect(await invalidProps(UpdateMemberRoleDto, { role })).toEqual([]);
    }
  });

  it.each([['SUPER_ADMIN'], ['Super_Admin'], ['owner'], ['']])(
    'rejects %p too — @IsIn is exact, so no casing trick gets through',
    async (role) => {
      expect(await invalidProps(UpdateMemberRoleDto, { role })).toEqual(['role']);
    },
  );

  it('still validates userId as a UUID', async () => {
    expect(await invalidProps(AssignUserDto, { userId: 'not-a-uuid', role: 'admin' })).toEqual([
      'userId',
    ]);
  });
});
