/** Badge variant for an HTTP status: server errors alarm, client errors recede, the rest is plain. */
export function statusVariant(code: number): 'default' | 'secondary' | 'destructive' {
  if (code >= 500) return 'destructive';
  if (code >= 400) return 'secondary';
  return 'default';
}
