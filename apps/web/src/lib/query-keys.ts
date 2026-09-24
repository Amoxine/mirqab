export const queryKeys = {
  apis: {
    all: ['apis'] as const,
    lists: () => [...queryKeys.apis.all, 'list'] as const,
    list: (params: Record<string, string>) => [...queryKeys.apis.lists(), params] as const,
    detail: (id: string) => [...queryKeys.apis.all, 'detail', id] as const,
    keys: (id: string) => [...queryKeys.apis.all, 'detail', id, 'keys'] as const,
    clients: (id: string) => [...queryKeys.apis.all, 'detail', id, 'clients'] as const,
  },
  keys: {
    all: ['keys'] as const,
    lists: () => [...queryKeys.keys.all, 'list'] as const,
    list: (params: Record<string, string>) => [...queryKeys.keys.lists(), params] as const,
    detail: (id: string) => [...queryKeys.keys.all, 'detail', id] as const,
    usage: (id: string, range: string) => [...queryKeys.keys.all, 'detail', id, 'usage', range] as const,
  },
  gateway: {
    status: ['gateway', 'status'] as const,
    nodeHealth: ['gateway', 'nodes', 'health'] as const,
  },
  settings: {
    all: ['settings'] as const,
  },
  tenants: {
    all: ['tenants'] as const,
    lists: () => [...queryKeys.tenants.all, 'list'] as const,
    list: (params: Record<string, string>) => [...queryKeys.tenants.lists(), params] as const,
    detail: (id: string) => [...queryKeys.tenants.all, 'detail', id] as const,
    members: (id: string) => [...queryKeys.tenants.all, 'detail', id, 'members'] as const,
  },
  analytics: {
    all: ['analytics'] as const,
    overview: (range: string) => [...queryKeys.analytics.all, 'overview', range] as const,
    apis: (range: string) => [...queryKeys.analytics.all, 'apis', range] as const,
    keys: (range: string) => [...queryKeys.analytics.all, 'keys', range] as const,
    timeseries: (metric: string, range: string) => [...queryKeys.analytics.all, 'timeseries', metric, range] as const,
    statusCodes: (range: string) => [...queryKeys.analytics.all, 'status-codes', range] as const,
    health: ['analytics', 'health'] as const,
  },
  audit: {
    all: ['audit-logs'] as const,
    lists: (params: Record<string, string>) => [...queryKeys.audit.all, 'list', params] as const,
    stats: (range: string) => [...queryKeys.audit.all, 'stats', range] as const,
    recent: ['audit-logs', 'recent'] as const,
  },
  auth: {
    me: ['auth', 'me'] as const,
  },
};
