/**
 * City catalogue for gateway node locations. A node is assigned with a city id in
 * `NEXT_PUBLIC_GATEWAY_NODE_LOCATIONS` (see gateway-locations.ts), e.g. `"MA-CASABLANCA"`.
 *
 * Id = ISO country code + `-` + the city name upper-cased with everything but A-Z removed
 * ("El Jadida" in Morocco → `MA-ELJADIDA`). Coordinates are city centres, rounded to 4 decimals.
 * Morocco is complete for cities of regional weight; the rest are the main hubs per country —
 * add a row to extend (a node can also carry explicit `lat`/`lon`, no catalogue entry needed).
 * The dashboard map only draws lon -92..31 / lat 14..64; cities outside are still valid, just unpinned.
 */
export interface CatalogCity {
  id: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  city: string;
  /** IATA / short code shown on the pin, when the city has a well-known one. */
  code?: string;
  lat: number;
  lon: number;
}

type Row = [country: string, city: string, code: string | undefined, lat: number, lon: number];

const idOf = (country: string, city: string) =>
  `${country}-${city.toUpperCase().replace(/[^A-Z]/g, '')}`;

const ROWS: Row[] = [
  // ── Morocco (MA) ────────────────────────────────────────────────
  ['MA', 'Casablanca', 'CMN', 33.5731, -7.5898],
  ['MA', 'Rabat', 'RBA', 34.0209, -6.8416],
  ['MA', 'Marrakech', 'RAK', 31.6295, -7.9811],
  ['MA', 'Fès', 'FEZ', 34.0181, -5.0078],
  ['MA', 'Tangier', 'TNG', 35.7595, -5.834],
  ['MA', 'Agadir', 'AGA', 30.4278, -9.5981],
  ['MA', 'Meknès', 'MEK', 33.8935, -5.5473],
  ['MA', 'Oujda', 'OUD', 34.6867, -1.9114],
  ['MA', 'Kénitra', undefined, 34.261, -6.5802],
  ['MA', 'Tétouan', 'TTU', 35.5785, -5.3684],
  ['MA', 'Safi', undefined, 32.2994, -9.2372],
  ['MA', 'El Jadida', undefined, 33.2316, -8.5007],
  ['MA', 'Nador', 'NDR', 35.1681, -2.9335],
  ['MA', 'Laâyoune', 'EUN', 27.1253, -13.1625],
  ['MA', 'Dakhla', 'VIL', 23.6848, -15.9579],
  ['MA', 'Essaouira', 'ESU', 31.5085, -9.7595],
  ['MA', 'Al Hoceïma', 'AHU', 35.2517, -3.9372],
  ['MA', 'Ouarzazate', 'OZZ', 30.9335, -6.937],
  ['MA', 'Errachidia', 'ERH', 31.9314, -4.4244],
  ['MA', 'Béni Mellal', undefined, 32.3373, -6.3498],
  ['MA', 'Khouribga', undefined, 32.8811, -6.9063],
  ['MA', 'Mohammedia', undefined, 33.6866, -7.383],
  ['MA', 'Taza', undefined, 34.21, -4.01],
  ['MA', 'Settat', undefined, 33.0011, -7.6166],
  ['MA', 'Berrechid', undefined, 33.2655, -7.5875],
  ['MA', 'Larache', undefined, 35.1932, -6.1557],
  ['MA', 'Guelmim', 'GLN', 28.987, -10.0574],
  ['MA', 'Tiznit', undefined, 29.6974, -9.7316],
  ['MA', 'Taroudant', undefined, 30.4703, -8.877],
  ['MA', 'Khémisset', undefined, 33.8244, -6.0661],
  ['MA', 'Ifrane', undefined, 33.5228, -5.1106],
  ['MA', 'Chefchaouen', undefined, 35.1688, -5.2636],
  ['MA', 'Salé', undefined, 34.0531, -6.7985],
  ['MA', 'Témara', undefined, 33.9287, -6.9066],
  ['MA', 'Ksar el-Kébir', undefined, 35.0017, -5.9036],
  ['MA', 'Youssoufia', undefined, 32.2465, -8.5289],
  ['MA', 'Sidi Kacem', undefined, 34.2214, -5.7071],
  ['MA', 'Midelt', undefined, 32.6852, -4.7451],
  ['MA', 'Zagora', undefined, 30.3324, -5.8384],
  ['MA', 'Tan-Tan', 'TTA', 28.438, -11.1032],
  ['MA', 'Smara', undefined, 26.7384, -11.6719],
  ['MA', 'Berkane', undefined, 34.92, -2.32],
  ['MA', 'Taourirt', undefined, 34.4056, -2.898],
  ['MA', 'Fnideq', undefined, 35.8489, -5.3626],
  ['MA', 'Martil', undefined, 35.6167, -5.2749],
  ['MA', 'Skhirat', undefined, 33.85, -7.0333],
  ['MA', 'Azrou', undefined, 33.4342, -5.221],
  ['MA', 'Benguerir', undefined, 32.236, -7.953],
  // ── Maghreb & West Africa ───────────────────────────────────────
  ['DZ', 'Algiers', 'ALG', 36.7538, 3.0588],
  ['DZ', 'Oran', 'ORN', 35.6971, -0.6308],
  ['TN', 'Tunis', 'TUN', 36.8065, 10.1815],
  ['MR', 'Nouakchott', 'NKC', 18.0735, -15.9582],
  ['SN', 'Dakar', 'DSS', 14.7167, -17.4677],
  ['CI', 'Abidjan', 'ABJ', 5.3599, -4.0083],
  ['GH', 'Accra', 'ACC', 5.6037, -0.187],
  ['NG', 'Lagos', 'LOS', 6.5244, 3.3792],
  ['EG', 'Cairo', 'CAI', 30.0444, 31.2357],
  ['ZA', 'Johannesburg', 'JNB', -26.2041, 28.0473],
  ['KE', 'Nairobi', 'NBO', -1.2921, 36.8219],
  // ── Europe ──────────────────────────────────────────────────────
  ['FR', 'Paris', 'PAR', 48.8566, 2.3522],
  ['FR', 'Marseille', 'MRS', 43.2965, 5.3698],
  ['FR', 'Lyon', 'LYS', 45.764, 4.8357],
  ['ES', 'Madrid', 'MAD', 40.4168, -3.7038],
  ['ES', 'Barcelona', 'BCN', 41.3851, 2.1734],
  ['PT', 'Lisbon', 'LIS', 38.7223, -9.1393],
  ['GB', 'London', 'LON', 51.5074, -0.1278],
  ['IE', 'Dublin', 'DUB', 53.3498, -6.2603],
  ['NL', 'Amsterdam', 'AMS', 52.3676, 4.9041],
  ['BE', 'Brussels', 'BRU', 50.8503, 4.3517],
  ['DE', 'Frankfurt', 'FRA', 50.1109, 8.6821],
  ['DE', 'Berlin', 'BER', 52.52, 13.405],
  ['CH', 'Zurich', 'ZRH', 47.3769, 8.5417],
  ['IT', 'Milan', 'MIL', 45.4642, 9.19],
  ['IT', 'Rome', 'ROM', 41.9028, 12.4964],
  ['AT', 'Vienna', 'VIE', 48.2082, 16.3738],
  ['SE', 'Stockholm', 'STO', 59.3293, 18.0686],
  ['FI', 'Helsinki', 'HEL', 60.1699, 24.9384],
  ['PL', 'Warsaw', 'WAW', 52.2297, 21.0122],
  ['TR', 'Istanbul', 'IST', 41.0082, 28.9784],
  // ── Americas ────────────────────────────────────────────────────
  ['US', 'Ashburn', 'IAD', 39.0438, -77.4874],
  ['US', 'New York', 'NYC', 40.7128, -74.006],
  ['US', 'Atlanta', 'ATL', 33.749, -84.388],
  ['US', 'Miami', 'MIA', 25.7617, -80.1918],
  ['US', 'Chicago', 'CHI', 41.8781, -87.6298],
  ['US', 'Dallas', 'DFW', 32.7767, -96.797],
  ['US', 'San Francisco', 'SFO', 37.7749, -122.4194],
  ['US', 'Los Angeles', 'LAX', 34.0522, -118.2437],
  ['US', 'Seattle', 'SEA', 47.6062, -122.3321],
  ['CA', 'Toronto', 'YYZ', 43.6532, -79.3832],
  ['CA', 'Montréal', 'YUL', 45.5017, -73.5673],
  ['MX', 'Mexico City', 'MEX', 19.4326, -99.1332],
  ['BR', 'São Paulo', 'GRU', -23.5505, -46.6333],
  ['AR', 'Buenos Aires', 'EZE', -34.6037, -58.3816],
  ['CL', 'Santiago', 'SCL', -33.4489, -70.6693],
  ['CO', 'Bogotá', 'BOG', 4.711, -74.0721],
  // ── Middle East & Asia-Pacific ──────────────────────────────────
  ['AE', 'Dubai', 'DXB', 25.2048, 55.2708],
  ['SA', 'Riyadh', 'RUH', 24.7136, 46.6753],
  ['IL', 'Tel Aviv', 'TLV', 32.0853, 34.7818],
  ['IN', 'Mumbai', 'BOM', 19.076, 72.8777],
  ['SG', 'Singapore', 'SIN', 1.3521, 103.8198],
  ['HK', 'Hong Kong', 'HKG', 22.3193, 114.1694],
  ['JP', 'Tokyo', 'TYO', 35.6762, 139.6503],
  ['KR', 'Seoul', 'SEL', 37.5665, 126.978],
  ['AU', 'Sydney', 'SYD', -33.8688, 151.2093],
];

export const CITIES: readonly CatalogCity[] = ROWS.map(([country, city, code, lat, lon]) => ({
  id: idOf(country, city),
  country,
  city,
  code,
  lat,
  lon,
}));

const BY_ID = new Map(CITIES.map((c) => [c.id, c]));

/** Looks a city up by id, case-insensitively and ignoring spaces / hyphens after the country code. */
export function cityById(id: string): CatalogCity | undefined {
  const [country = '', ...rest] = id.trim().toUpperCase().split('-');
  return BY_ID.get(`${country}-${rest.join('').replace(/[^A-Z]/g, '')}`);
}
