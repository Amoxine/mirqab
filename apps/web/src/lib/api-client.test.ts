import { afterEach, describe, expect, it, vi } from 'vitest';
import { canAttemptReauth } from './api-client';

/** In-memory stand-in for `sessionStorage` — not available in the default (node) vitest env. */
function fakeSessionStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

describe('canAttemptReauth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('allows one attempt, blocks a repeat within the window, allows again once it passes', () => {
    vi.stubGlobal('sessionStorage', fakeSessionStorage());
    const now = vi.spyOn(Date, 'now');

    now.mockReturnValue(0);
    expect(canAttemptReauth()).toBe(true);
    expect(canAttemptReauth()).toBe(false);

    now.mockReturnValue(4999);
    expect(canAttemptReauth()).toBe(false);

    now.mockReturnValue(5000);
    expect(canAttemptReauth()).toBe(true);
  });

  it('allows the attempt when sessionStorage throws (private mode, etc.)', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });

    expect(canAttemptReauth()).toBe(true);
  });
});
