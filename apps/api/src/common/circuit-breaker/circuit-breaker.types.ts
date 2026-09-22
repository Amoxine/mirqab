/** States of the circuit breaker state machine */
export enum CircuitState {
  /** Circuit is closed, requests flow through normally */
  CLOSED = 'CLOSED',
  /** Circuit is open, requests are blocked immediately */
  OPEN = 'OPEN',
  /** Circuit is half-open, limited test requests allowed */
  HALF_OPEN = 'HALF_OPEN',
}

/** Configuration for a circuit breaker instance */
export interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening the circuit (default: 5) */
  failureThreshold?: number;
  /** Seconds to wait before transitioning from OPEN to HALF_OPEN (default: 30) */
  resetTimeout?: number;
  /** Maximum concurrent calls allowed in HALF_OPEN state (default: 2) */
  halfOpenMaxCalls?: number;
}

/** Result of executing through a circuit breaker. A discriminated union so callers can narrow on `success`. */
export type CircuitBreakerResult<T> =
  | { success: true; data: T; circuitState: CircuitState }
  | { success: false; error: Error; circuitState: CircuitState };

/** Internal tracking data for a circuit breaker instance */
export interface CircuitBreakerState {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureTime: number | null;
  lastStateChangeTime: number;
  halfOpenCalls: number;
}

/** Error thrown when circuit breaker is OPEN */
export class CircuitBreakerOpenError extends Error {
  constructor(
    public readonly circuitName: string,
    public readonly retryAfterMs: number,
  ) {
    super(
      `Circuit breaker "${circuitName}" is OPEN. Retry after ${String(retryAfterMs)}ms.`,
    );
    this.name = 'CircuitBreakerOpenError';
  }
}
