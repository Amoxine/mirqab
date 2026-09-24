import 'reflect-metadata';
import { prisma } from '@open-gateway/database';
import { WebhookRelayService } from './webhook-relay.service';

jest.mock('@open-gateway/database', () => ({
  prisma: {
    webhookSubscription: { findMany: jest.fn() },
    webhookDelivery: { create: jest.fn() },
  },
}));

type Fn = jest.Mock;
const db = {
  sub: prisma.webhookSubscription as unknown as Record<'findMany', Fn>,
  delivery: prisma.webhookDelivery as unknown as Record<'create', Fn>,
};

function subRow(overrides: Record<string, unknown> = {}) {
  return { id: 'sub-1', apiId: 'api-1', receiverUrl: 'https://example.com/hook', secret: 'shh', active: true, ...overrides };
}

describe('WebhookRelayService', () => {
  let service: WebhookRelayService;
  let fetchMock: Fn;

  beforeEach(() => {
    jest.resetAllMocks();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    service = new WebhookRelayService();
  });

  it('does nothing when the api has no active subscriptions', async () => {
    db.sub.findMany.mockResolvedValue([]);

    await service.relay('api-1', { event: 'QuotaExceeded', key: 'live-key-value' });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('redacts the raw key, signs the body, and logs SUCCESS on the first attempt', async () => {
    db.sub.findMany.mockResolvedValue([subRow()]);
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await service.relay('api-1', { event: 'QuotaExceeded', message: 'quota exceeded', key: 'live-key-value' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.com/hook');
    expect(init.body as string).not.toContain('live-key-value');
    expect((init.headers as Record<string, string>)['X-Webhook-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);

    const [[created]] = db.delivery.create.mock.calls as [[{ data: Record<string, unknown> }]];
    expect(created.data).toMatchObject({ subscriptionId: 'sub-1', status: 'SUCCESS', attempts: 1, responseStatus: 200 });
  });

  it('retries up to 3 attempts total and logs FAILED once exhausted', async () => {
    jest.useFakeTimers();
    db.sub.findMany.mockResolvedValue([subRow()]);
    fetchMock.mockResolvedValue({ ok: false, status: 503 });

    const relayPromise = service.relay('api-1', { event: 'AuthFailure' });
    await jest.runAllTimersAsync();
    await relayPromise;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [[created]] = db.delivery.create.mock.calls as [[{ data: Record<string, unknown> }]];
    expect(created.data).toMatchObject({ status: 'FAILED', attempts: 3, responseStatus: 503 });

    jest.useRealTimers();
  });
});
