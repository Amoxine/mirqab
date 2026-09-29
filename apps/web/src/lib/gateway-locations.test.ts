import { describe, expect, it } from 'vitest';
import { isOnMap } from '@open-gateway/ui';
import { CITIES, cityById } from './gateway-cities';
import { parseLocations } from './gateway-locations';

describe('gateway city catalogue', () => {
  it('has unique ids and valid coordinates', () => {
    expect(new Set(CITIES.map((c) => c.id)).size).toBe(CITIES.length);
    for (const c of CITIES) {
      expect(Math.abs(c.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(c.lon)).toBeLessThanOrEqual(180);
    }
  });

  it('covers every Moroccan city on the dashboard map', () => {
    const morocco = CITIES.filter((c) => c.country === 'MA');
    expect(morocco.length).toBeGreaterThanOrEqual(45);
    expect(morocco.every((c) => isOnMap(c.lat, c.lon))).toBe(true);
  });

  it('finds a city ignoring case, spaces and hyphens', () => {
    expect(cityById('ma-el-jadida')?.city).toBe('El Jadida');
    expect(cityById('MA-CASABLANCA')?.code).toBe('CMN');
    expect(cityById('MA-NOWHERE')).toBeUndefined();
  });
});

describe('parseLocations', () => {
  it('accepts catalogue ids and explicit objects, and drops what is invalid', () => {
    const out = parseLocations(
      JSON.stringify({
        'a:1': 'MA-RABAT',
        'b:2': { city: 'Lab', lat: 10, lon: 20 },
        'c:3': 'XX-NOPE',
        'd:4': { city: 'Bad', lat: 999, lon: 0 },
      }),
    );
    expect(Object.keys(out)).toEqual(['a:1', 'b:2']);
    expect(out['a:1']?.city).toBe('Rabat');
  });

  it('is empty for missing or malformed input', () => {
    expect(parseLocations(undefined)).toEqual({});
    expect(parseLocations('{nope')).toEqual({});
  });
});
