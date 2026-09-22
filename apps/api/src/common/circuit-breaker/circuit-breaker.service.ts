import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  CircuitBreakerConfig,
  CircuitBreakerOpenError,
  CircuitBreakerResult,
  CircuitBreakerState,
  CircuitState,
} from './circuit-breaker.types';

const DEFAULT_CONFIG: Required<CircuitBreakerConfig> = {
  failureThreshold: 5,
  resetTimeout: 30,
  halfOpenMaxCalls: 2,
};

/** Unreachable fallback for `getOrCreateCircuit`: `register()` always seeds the map. */
const UNREGISTERED_CIRCUIT: CircuitBreakerState = {
  state: CircuitState.CLOSED,
  failureCount: 0,
  successCount: 0,
  lastFailureTime: null,
  lastStateChangeTime: 0,
  halfOpenCalls: 0,
};

@Injectable()
export class CircuitBreakerService implements OnModuleDestroy {
  private readonly logger = new Logger(CircuitBreakerService.name);
  private readonly circuits = new Map<string, CircuitBreakerState>();
  private readonly configs = new Map<string, Required<CircuitBreakerConfig>>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Register a circuit breaker with the given name and configuration.
   * Call this once per logical circuit (e.g. per external service).
   */
  register(name: string, config?: CircuitBreakerConfig): void {
    const merged: Required<CircuitBreakerConfig> = {
      ...DEFAULT_CONFIG,
      ...config,
    };
    this.configs.set(name, merged);
    this.circuits.set(name, {
      state: CircuitState.CLOSED,
      failureCount: 0,
      successCount: 0,
      lastFailureTime: null,
      lastStateChangeTime: Date.now(),
      halfOpenCalls: 0,
    });
    this.logger.log(
      `Circuit breaker "${name}" registered (threshold: ${String(merged.failureThreshold)}, reset: ${String(merged.resetTimeout)}s, half-open max: ${String(merged.halfOpenMaxCalls)})`,
    );

    // Start cleanup timer if not already running
    if (!this.cleanupInterval) {
      this.startCleanupInterval();
    }
  }

  /**
   * Execute a function through the named circuit breaker.
   *
   * - CLOSED: execute and track success/failure
   * - OPEN: check if reset timeout elapsed → HALF_OPEN or throw
   * - HALF_OPEN: allow limited calls, promote to CLOSED on success or back to OPEN on failure
   */
  async execute<T>(
    name: string,
    fn: () => Promise<T>,
  ): Promise<CircuitBreakerResult<T>> {
    const state = this.getOrCreateCircuit(name);
    const config = this.configs.get(name) ?? DEFAULT_CONFIG;

    // Check if we should transition OPEN → HALF_OPEN
    if (state.state === CircuitState.OPEN) {
      const elapsed = (Date.now() - state.lastStateChangeTime) / 1000;
      if (elapsed >= config.resetTimeout) {
        this.transitionTo(name, CircuitState.HALF_OPEN);
      } else {
        const retryAfterMs =
          (config.resetTimeout - elapsed) * 1000;
        this.logger.warn(
          `Circuit "${name}" is OPEN. Retry after ${String(Math.round(retryAfterMs))}ms`,
        );
        throw new CircuitBreakerOpenError(name, retryAfterMs);
      }
    }

    // Enforce half-open call limit
    if (
      state.state === CircuitState.HALF_OPEN &&
      state.halfOpenCalls >= config.halfOpenMaxCalls
    ) {
      throw new CircuitBreakerOpenError(name, config.resetTimeout * 1000);
    }

    if (state.state === CircuitState.HALF_OPEN) {
      state.halfOpenCalls += 1;
    }

    try {
      const result = await fn();
      this.onSuccess(name);
      return { success: true, data: result, circuitState: state.state };
    } catch (error) {
      this.onFailure(name);
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        circuitState: state.state,
      };
    }
  }

  /** Get current state of all registered circuits */
  getStatus(): Record<string, { state: CircuitState; failureCount: number }> {
    const result: Record<string, { state: CircuitState; failureCount: number }> = {};
    for (const [name, state] of Array.from(this.circuits.entries())) {
      result[name] = {
        state: state.state,
        failureCount: state.failureCount,
      };
    }
    return result;
  }

  /** Reset a specific circuit back to CLOSED */
  reset(name: string): void {
    const state = this.circuits.get(name);
    if (state) {
      this.transitionTo(name, CircuitState.CLOSED);
      this.logger.log(`Circuit "${name}" manually reset to CLOSED`);
    }
  }

  /** Reset all circuits to CLOSED */
  resetAll(): void {
    for (const name of Array.from(this.circuits.keys())) {
      this.reset(name);
    }
  }

  onModuleDestroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private getOrCreateCircuit(name: string): CircuitBreakerState {
    const existing = this.circuits.get(name);
    if (existing) return existing;

    this.register(name);
    // register() always seeds the map, so the second read cannot miss.
    return this.circuits.get(name) ?? UNREGISTERED_CIRCUIT;
  }

  private onSuccess(name: string): void {
    const state = this.circuits.get(name);
    if (!state) return;

    state.failureCount = 0;
    state.successCount += 1;

    if (state.state === CircuitState.HALF_OPEN) {
      this.transitionTo(name, CircuitState.CLOSED);
      this.logger.log(`Circuit "${name}" transitioned HALF_OPEN → CLOSED`);
    }

    if (state.state === CircuitState.CLOSED) {
      state.halfOpenCalls = 0;
    }
  }

  private onFailure(name: string): void {
    const state = this.circuits.get(name);
    const config = this.configs.get(name) ?? DEFAULT_CONFIG;
    if (!state) return;

    state.failureCount += 1;
    state.lastFailureTime = Date.now();
    state.halfOpenCalls = 0;

    if (
      state.state === CircuitState.CLOSED &&
      state.failureCount >= config.failureThreshold
    ) {
      this.transitionTo(name, CircuitState.OPEN);
      this.logger.warn(
        `Circuit "${name}" tripped OPEN after ${String(state.failureCount)} failures`,
      );
    }

    if (state.state === CircuitState.HALF_OPEN) {
      this.transitionTo(name, CircuitState.OPEN);
      this.logger.warn(
        `Circuit "${name}" failed during HALF_OPEN test, returning to OPEN`,
      );
    }
  }

  private transitionTo(name: string, newState: CircuitState): void {
    const state = this.circuits.get(name);
    if (!state) return;

    state.state = newState;
    state.lastStateChangeTime = Date.now();
    state.halfOpenCalls = 0;

    if (newState === CircuitState.CLOSED) {
      state.failureCount = 0;
      state.successCount = 0;
    }
  }

  private startCleanupInterval(): void {
    // Every 60 seconds, check for stale transitions
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [name, state] of Array.from(this.circuits.entries())) {
        const config = this.configs.get(name) ?? DEFAULT_CONFIG;
        if (
          state.state === CircuitState.OPEN &&
          state.lastStateChangeTime > 0 &&
          (now - state.lastStateChangeTime) / 1000 >= config.resetTimeout * 2
        ) {
          // Auto-transition to HALF_OPEN if reset timeout has passed
          this.transitionTo(name, CircuitState.HALF_OPEN);
          this.logger.debug(
            `Circuit "${name}" auto-transitioned OPEN → HALF_OPEN during cleanup`,
          );
        }
      }
    }, 60000);
  }
}
