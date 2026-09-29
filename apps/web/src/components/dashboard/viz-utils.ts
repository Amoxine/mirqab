export {
  columnPath,
  fx,
  niceTicks,
  useElementWidth,
  usePrefersReducedMotion,
} from '@open-gateway/ui';

/** Error rate of a bucket as a percentage (0-100); null when the bucket carried no requests. */
export const bucketErrorRate = (p: { requests: number; errors: number }): number | null =>
  p.requests > 0 ? (p.errors / p.requests) * 100 : null;
