// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import apisMessages from '@/messages/en/apis.json';
import commonMessages from '@/messages/en/common.json';
import { baseApi, wrap } from './test-utils';
import { TrafficLimitsSheet } from './traffic-limits-sheet';

const M = apisMessages;

const mutateAsync = vi.fn().mockResolvedValue(undefined);
vi.mock('@/hooks/use-apis', () => ({
  useUpdateApi: () => ({ mutateAsync }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TrafficLimitsSheet', () => {
  it('saves rate limit, throttle and timeout, with the circuit breaker left off as null', async () => {
    render(wrap(<TrafficLimitsSheet api={baseApi} open onOpenChange={() => undefined} />));

    fireEvent.change(screen.getByLabelText(M.form.requestsLabel), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText(M.designer.traffic.timeoutSeconds), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: commonMessages.save }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({
        config: {
          rateLimit: { rate: 50, per: 60 },
          throttle: { retryLimit: 0, intervalSeconds: 10 },
          timeoutSeconds: 5,
          requestSizeLimitBytes: null,
          circuitBreaker: null,
        },
      });
    });
  });

  it('sends the circuit breaker object once its switch is turned on', async () => {
    render(wrap(<TrafficLimitsSheet api={baseApi} open onOpenChange={() => undefined} />));

    fireEvent.click(screen.getByLabelText(M.designer.traffic.circuitBreaker));
    fireEvent.click(screen.getByRole('button', { name: commonMessages.save }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({
        config: {
          rateLimit: { rate: 0, per: 60 },
          throttle: { retryLimit: 0, intervalSeconds: 10 },
          timeoutSeconds: null,
          requestSizeLimitBytes: null,
          circuitBreaker: { threshold: 0.5, sampleSize: 100, coolDownSeconds: 60 },
        },
      });
    });
  });
});
