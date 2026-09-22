import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PumpHealthService } from './pump-health.service';

const PUMP_URL = 'http://tyk-pump:8083/health';

function makeProbe(config: Record<string, string> = { PUMP_HEALTH_URL: PUMP_URL }): PumpHealthService {
  return new PumpHealthService(new ConfigService(config));
}

describe('PumpHealthService', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('is reachable when the health endpoint answers 200, probing the configured URL with a timeout signal', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{"status": "ok"}', { status: 200 }));

    await expect(makeProbe().isReachable()).resolves.toBe(true);

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(PUMP_URL);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('is unreachable, without throwing, on a network error', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(makeProbe().isReachable()).resolves.toBe(false);
  });

  it('is unreachable, without throwing, on a probe timeout', async () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    fetchSpy.mockRejectedValueOnce(timeout);

    await expect(makeProbe().isReachable()).resolves.toBe(false);
  });

  it('is unreachable on a non-2xx answer', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('down', { status: 503 }));

    await expect(makeProbe().isReachable()).resolves.toBe(false);
  });

  describe('probe timeout threshold', () => {
    let timeoutSpy: jest.SpiedFunction<typeof AbortSignal.timeout>;

    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
      // Node's AbortSignal.timeout runs on internal timers jest cannot fake: rebuild it on the
      // (fake) global setTimeout so the real threshold the service passes is what gets advanced.
      timeoutSpy = jest.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
        const controller = new AbortController();
        setTimeout(() => {
          controller.abort(new DOMException('The operation timed out', 'TimeoutError'));
        }, ms);
        return controller.signal;
      });
      // a hanging pump: settles only when the signal aborts
      fetchSpy.mockImplementation(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(init.signal?.reason as Error);
            });
          }),
      );
    });

    afterEach(() => {
      timeoutSpy.mockRestore();
      jest.useRealTimers();
    });

    it('gives a hanging pump exactly 3000 ms before reporting it unreachable', async () => {
      let settled: boolean | undefined;
      const probe = makeProbe()
        .isReachable()
        .then((reachable) => (settled = reachable));

      expect(timeoutSpy).toHaveBeenCalledWith(3000);

      await jest.advanceTimersByTimeAsync(2999);
      expect(settled).toBeUndefined();

      await jest.advanceTimersByTimeAsync(1);
      await expect(probe).resolves.toBe(false);
      expect(settled).toBe(false);
    });
  });

  it('is unreachable, without any request, when PUMP_HEALTH_URL is unset', async () => {
    await expect(makeProbe({}).isReachable()).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
