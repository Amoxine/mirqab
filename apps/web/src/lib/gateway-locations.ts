import { z } from 'zod';
import { isOnMap } from '@open-gateway/ui';
import { cityById } from './gateway-cities';

const locationSchema = z.object({
  city: z.string().min(1),
  /** Short code shown above the city on the pin (airport / region), optional. */
  code: z.string().optional(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});
export type GatewayLocation = z.infer<typeof locationSchema>;

/**
 * Where each gateway node runs, keyed by the node URL's host, from `NEXT_PUBLIC_GATEWAY_NODE_LOCATIONS`.
 * A value is either a catalogue city id (see gateway-cities.ts) or an explicit location:
 * `{"gw-1:8080":"MA-CASABLANCA","gw-2:8080":{"city":"Paris","code":"PAR","lat":48.86,"lon":2.35}}`.
 * The control plane does not know node locations, so a node without a (valid) entry is listed but not pinned.
 */
export function parseLocations(raw: string | undefined): Record<string, GatewayLocation> {
  if (!raw) return {};
  let parsed: Record<string, unknown>;
  try {
    parsed = z.record(z.string(), z.unknown()).parse(JSON.parse(raw));
  } catch {
    return {};
  }
  const out: Record<string, GatewayLocation> = {};
  for (const [host, value] of Object.entries(parsed)) {
    if (typeof value === 'string') {
      const c = cityById(value);
      if (c) out[host] = { city: c.city, code: c.code, lat: c.lat, lon: c.lon };
      continue;
    }
    const explicit = locationSchema.safeParse(value);
    if (explicit.success) out[host] = explicit.data;
  }
  return out;
}

const LOCATIONS = parseLocations(process.env.NEXT_PUBLIC_GATEWAY_NODE_LOCATIONS);

/** The node's configured location, if it has one that falls inside the map's crop. */
export function locationOf(host: string): GatewayLocation | null {
  const loc = LOCATIONS[host];
  return loc && isOnMap(loc.lat, loc.lon) ? loc : null;
}
