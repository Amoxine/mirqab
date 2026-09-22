import { SetMetadata } from '@nestjs/common';

export const AUDIT_KEY = 'AUDIT_METADATA';

export interface AuditMeta {
  /** The action being audited (e.g. 'create', 'update', 'delete') */
  action: string;
  /** The entity/resource type (e.g. 'User', 'ApiDefinition'). Auto-detected if omitted. */
  entityType?: string;
}

/**
 * Decorator to mark a route handler for audit logging.
 * The AuditLogInterceptor reads this metadata to capture audit entries.
 *
 * @example
 * ```ts
 * @Audit('delete')
 * @Delete(':id')
 * removeUser(@Param('id') id: string) { ... }
 * ```
 *
 * @param action - The audit action label
 * @param entityType - Optional entity type (auto-detected from controller class name if omitted)
 */
export const Audit = (action: string, entityType?: string): MethodDecorator => {
  const meta: AuditMeta = { action, entityType };
  return SetMetadata(AUDIT_KEY, meta);
};
