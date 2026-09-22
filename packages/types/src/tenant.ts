export type TenantStatus = 'active' | 'suspended' | 'trial' | 'expired' | 'pending_setup';

export interface TenantConfig {
  id: string;
  tenantId: string;
  domain: string | null;
  branding: {
    logoUrl: string | null;
    faviconUrl: string | null;
    primaryColor: string | null;
    companyName: string;
  };
  features: Record<string, boolean>;
  settings: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface TenantSubscription {
  id: string;
  tenantId: string;
  plan: 'free' | 'starter' | 'professional' | 'enterprise';
  status: TenantStatus;
  seats: number;
  billingCycle: 'monthly' | 'yearly';
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  trialEndsAt: Date | null;
  canceledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  subscription: TenantSubscription;
  config: TenantConfig;
  ownerUserId: string;
  createdAt: Date;
  updatedAt: Date;
}
