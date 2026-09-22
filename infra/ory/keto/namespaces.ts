// Ory Permission Language (OPL) — the authorization model Keto compiles at boot.
//
// This is WP1's minimum: exactly the model that was verified end to end (namespaces compile and
// load, tuples write, and both direct relations and computed permits answer `check` correctly).
//
// WP2 extends it. The existing system's 27 permission names (`api:read`, `key:create`, …) are NOT
// modelled yet — the intended shape is to add a `permits` entry per permission name on Tenant,
// composed from the relations below, so `check(Tenant:<id>#api:create@<user>)` replaces today's
// UserTenant→Role→RolePermission lookup. `super_admin` stays a bypass in the guard, not a tuple.
//
// Relation vs. permit: a relation is a stored tuple (written via the write API); a permit is
// computed at check time from relations. Both are queried through the same `check` endpoint.

import { Namespace, Context } from "@ory/permission-namespace-types"

class User implements Namespace {}

class Tenant implements Namespace {
  related: {
    member: User[]
    admin: User[]
  }

  permits = {
    // Anyone attached to the tenant may see it; admins are members implicitly.
    view: (ctx: Context): boolean =>
      this.related.member.includes(ctx.subject) ||
      this.related.admin.includes(ctx.subject),

    // Tenant settings, membership and role changes.
    manage: (ctx: Context): boolean => this.related.admin.includes(ctx.subject),
  }
}
