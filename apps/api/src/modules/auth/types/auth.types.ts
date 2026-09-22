/**
 * DEPRECATED — dead since the Ory cutover (WP2). These described the payload this app used to sign
 * and the login/register responses it used to return; it now signs nothing and issues nothing. The
 * live session shape is UserPayload in common/types/index.ts, resolved per request by
 * services/auth.service.ts from a Hydra-issued token. Only services/token.service.ts (itself
 * deprecated) still imports this. Kept for history, not deleted (WP7 decision, 2026-09-20); safe to
 * delete in a future pass.
 */
export interface JwtPayload {
  sub: string;
  email: string;
  name: string;
  roles: string[];
  /** Permission names ('resource:action') granted to the user's role in the default tenant. */
  permissions: string[];
  tenantId?: string;
}

export interface AuthResponse {
  user: {
    id: string;
    email: string;
    name: string;
    roles: string[];
  };
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult extends AuthResponse {
  _tokens: AuthTokens;
}

