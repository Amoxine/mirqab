export type {
  UserRole,
  UserStatus,
  User,
  ApiError,
  ApiSuccessResponse,
  ApiErrorResponse,
  PaginatedResponse,
  ApiStatus,
  ApiKeyStatus,
  ApiHealthStatus,
  TenantStatus,
  AuditAction,
  AuthMe,
  ApiSyncStatus,
  ApiConfig,
  ApiConfigHeader,
  OasDocument,
  GatewayStatus,
  TenantSettings,
  NodeHealthEntry,
  GatewayReloadOutcome,
  AnalyticsRange,
  AnalyticsMetric,
  AnalyticsOverview,
  AnalyticsTimeSeriesPoint,
  AnalyticsApiRow,
  AnalyticsKeyRow,
  AnalyticsTopApi,
  AnalyticsStatusCode,
  AnalyticsHealth,
} from './local';

export interface LoginFormValues {
  email: string;
  password: string;
  rememberMe?: boolean;
}

export interface DashboardStats {
  totalUsers: number;
  activeSessions: number;
  revenue: number;
  errorRate: number;
}
