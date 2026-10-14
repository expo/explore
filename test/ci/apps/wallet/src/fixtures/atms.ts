/** A point on the map, in degrees. */
export type Coordinates = { latitude: number; longitude: number };

export type Atm = Coordinates & {
  id: string;
  name: string;
  address: string;
  /** Opening hours as shown, such as "Open 24 hours". */
  hours: string;
  /** Takes cash deposits as well as withdrawals. */
  deposits: boolean;
};

export type AtmCity = Coordinates & {
  id: string;
  name: string;
  country: string;
  /** The currency its ATMs pay out. */
  currency: string;
  atms: Atm[];
};

const DAY_AND_NIGHT = 'Open 24 hours';

/**
 * Wallet's partner ATMs, in the cities a simulator can be placed in from Xcode's (and the Viewer's)
 * location presets. Each city's coordinates are the preset's, so a preset lands in its city centre.
 */
export const ATM_CITIES: readonly AtmCity[] = [
  {
    id: 'berlin', name: 'Berlin', country: 'Germany', currency: 'EUR', latitude: 52.52, longitude: 13.405,
    atms: [
      { id: 'berlin-alexanderplatz', name: 'Alexanderplatz Station', address: 'Alexanderplatz, Mitte', hours: DAY_AND_NIGHT, deposits: true, latitude: 52.5219, longitude: 13.4132 },
      { id: 'berlin-hackescher-markt', name: 'Hackescher Markt', address: 'Neue Promenade, Mitte', hours: '6:00–23:00', deposits: false, latitude: 52.5225, longitude: 13.4024 },
      { id: 'berlin-friedrichstrasse', name: 'Friedrichstraße Station', address: 'Georgenstraße, Mitte', hours: DAY_AND_NIGHT, deposits: false, latitude: 52.5203, longitude: 13.387 },
      { id: 'berlin-rosenthaler-platz', name: 'Rosenthaler Platz', address: 'Weinbergsweg, Mitte', hours: '7:00–22:00', deposits: true, latitude: 52.5297, longitude: 13.4014 },
      { id: 'berlin-potsdamer-platz', name: 'Potsdamer Platz', address: 'Alte Potsdamer Straße, Tiergarten', hours: DAY_AND_NIGHT, deposits: false, latitude: 52.5096, longitude: 13.3759 },
    ],
  },
  {
    id: 'cupertino', name: 'Cupertino', country: 'United States', currency: 'USD', latitude: 37.323, longitude: -122.0322,
    atms: [
      { id: 'cupertino-de-anza', name: 'De Anza & Stevens Creek', address: 'Stevens Creek Blvd, Cupertino', hours: DAY_AND_NIGHT, deposits: true, latitude: 37.3232, longitude: -122.0318 },
      { id: 'cupertino-main-street', name: 'Main Street Cupertino', address: 'Stevens Creek Blvd, Cupertino', hours: '7:00–22:00', deposits: false, latitude: 37.3236, longitude: -122.0107 },
      { id: 'cupertino-college', name: 'De Anza College', address: 'Stevens Creek Blvd, Cupertino', hours: '7:00–21:00', deposits: false, latitude: 37.3196, longitude: -122.0453 },
      { id: 'cupertino-village', name: 'Cupertino Village', address: 'N Wolfe Rd, Cupertino', hours: DAY_AND_NIGHT, deposits: true, latitude: 37.3365, longitude: -122.0147 },
    ],
  },
  {
    id: 'hong-kong', name: 'Hong Kong', country: 'China', currency: 'HKD', latitude: 22.3193, longitude: 114.1694,
    atms: [
      { id: 'hong-kong-mong-kok', name: 'Mong Kok Station', address: 'Nathan Road, Mong Kok', hours: DAY_AND_NIGHT, deposits: true, latitude: 22.3192, longitude: 114.1696 },
      { id: 'hong-kong-langham-place', name: 'Langham Place', address: 'Portland Street, Mong Kok', hours: '10:00–23:00', deposits: false, latitude: 22.318, longitude: 114.1685 },
      { id: 'hong-kong-prince-edward', name: 'Prince Edward Station', address: 'Prince Edward Road West', hours: DAY_AND_NIGHT, deposits: false, latitude: 22.3245, longitude: 114.1683 },
      { id: 'hong-kong-yau-ma-tei', name: 'Yau Ma Tei Station', address: 'Nathan Road, Yau Ma Tei', hours: DAY_AND_NIGHT, deposits: true, latitude: 22.313, longitude: 114.1706 },
      { id: 'hong-kong-tsim-sha-tsui', name: 'Tsim Sha Tsui Station', address: 'Nathan Road, Tsim Sha Tsui', hours: DAY_AND_NIGHT, deposits: false, latitude: 22.2975, longitude: 114.1722 },
    ],
  },
  {
    id: 'johannesburg', name: 'Johannesburg', country: 'South Africa', currency: 'ZAR', latitude: -26.2041, longitude: 28.0473,
    atms: [
      { id: 'johannesburg-carlton-centre', name: 'Carlton Centre', address: 'Commissioner Street, Marshalltown', hours: '7:00–19:00', deposits: true, latitude: -26.2056, longitude: 28.047 },
      { id: 'johannesburg-park-station', name: 'Park Station', address: 'Rissik Street, Braamfontein', hours: DAY_AND_NIGHT, deposits: false, latitude: -26.1965, longitude: 28.0418 },
      { id: 'johannesburg-maboneng', name: 'Maboneng', address: 'Fox Street, Jeppestown', hours: '8:00–22:00', deposits: false, latitude: -26.2044, longitude: 28.059 },
      { id: 'johannesburg-braamfontein', name: 'Braamfontein', address: 'Jorissen Street, Braamfontein', hours: DAY_AND_NIGHT, deposits: true, latitude: -26.1929, longitude: 28.0305 },
    ],
  },
  {
    id: 'london', name: 'London', country: 'United Kingdom', currency: 'GBP', latitude: 51.5072, longitude: -0.1276,
    atms: [
      { id: 'london-charing-cross', name: 'Charing Cross Station', address: 'Strand, Westminster', hours: DAY_AND_NIGHT, deposits: false, latitude: 51.508, longitude: -0.1247 },
      { id: 'london-leicester-square', name: 'Leicester Square', address: 'Cranbourn Street, Westminster', hours: DAY_AND_NIGHT, deposits: true, latitude: 51.5113, longitude: -0.1281 },
      { id: 'london-covent-garden', name: 'Covent Garden', address: 'James Street, Covent Garden', hours: '7:00–23:00', deposits: false, latitude: 51.5117, longitude: -0.124 },
      { id: 'london-westminster', name: 'Westminster Station', address: 'Bridge Street, Westminster', hours: DAY_AND_NIGHT, deposits: false, latitude: 51.501, longitude: -0.1254 },
      { id: 'london-waterloo', name: 'Waterloo Station', address: 'Waterloo Road, Lambeth', hours: DAY_AND_NIGHT, deposits: true, latitude: 51.5031, longitude: -0.1132 },
    ],
  },
  {
    id: 'mexico-city', name: 'Mexico City', country: 'Mexico', currency: 'MXN', latitude: 19.4326, longitude: -99.1332,
    atms: [
      { id: 'mexico-city-zocalo', name: 'Zócalo', address: 'Plaza de la Constitución, Centro', hours: DAY_AND_NIGHT, deposits: true, latitude: 19.4336, longitude: -99.1331 },
      { id: 'mexico-city-madero', name: 'Calle Madero', address: 'Francisco I. Madero, Centro', hours: '8:00–22:00', deposits: false, latitude: 19.434, longitude: -99.137 },
      { id: 'mexico-city-bellas-artes', name: 'Bellas Artes', address: 'Avenida Juárez, Centro', hours: DAY_AND_NIGHT, deposits: false, latitude: 19.4352, longitude: -99.1412 },
      { id: 'mexico-city-revolucion', name: 'Monumento a la Revolución', address: 'Plaza de la República, Tabacalera', hours: '7:00–23:00', deposits: true, latitude: 19.4361, longitude: -99.1545 },
    ],
  },
  {
    id: 'mumbai', name: 'Mumbai', country: 'India', currency: 'INR', latitude: 19.076, longitude: 72.8777,
    atms: [
      { id: 'mumbai-kalina', name: 'Kalina', address: 'CST Road, Santacruz East', hours: DAY_AND_NIGHT, deposits: true, latitude: 19.0773, longitude: 72.8636 },
      { id: 'mumbai-kurla', name: 'Kurla Station', address: 'LBS Marg, Kurla West', hours: DAY_AND_NIGHT, deposits: false, latitude: 19.0655, longitude: 72.8793 },
      { id: 'mumbai-bkc', name: 'Bandra Kurla Complex', address: 'G Block, BKC', hours: '8:00–22:00', deposits: true, latitude: 19.066, longitude: 72.868 },
      { id: 'mumbai-sion', name: 'Sion Station', address: 'Sion Circle, Sion', hours: DAY_AND_NIGHT, deposits: false, latitude: 19.047, longitude: 72.863 },
    ],
  },
  {
    id: 'new-york', name: 'New York', country: 'United States', currency: 'USD', latitude: 40.7128, longitude: -74.006,
    atms: [
      { id: 'new-york-city-hall', name: 'City Hall Park', address: 'Broadway & Murray St', hours: DAY_AND_NIGHT, deposits: true, latitude: 40.7127, longitude: -74.0071 },
      { id: 'new-york-chambers-street', name: 'Chambers Street', address: 'Centre St & Chambers St', hours: DAY_AND_NIGHT, deposits: false, latitude: 40.7141, longitude: -74.0036 },
      { id: 'new-york-fulton-center', name: 'Fulton Center', address: 'Broadway & Fulton St', hours: '6:00–24:00', deposits: false, latitude: 40.7102, longitude: -74.0078 },
      { id: 'new-york-oculus', name: 'World Trade Center Oculus', address: 'Church St & Dey St', hours: DAY_AND_NIGHT, deposits: true, latitude: 40.7115, longitude: -74.011 },
      { id: 'new-york-wall-street', name: 'Wall Street', address: 'Wall St & William St', hours: DAY_AND_NIGHT, deposits: false, latitude: 40.7069, longitude: -74.009 },
    ],
  },
  {
    id: 'paris', name: 'Paris', country: 'France', currency: 'EUR', latitude: 48.8566, longitude: 2.3522,
    atms: [
      { id: 'paris-hotel-de-ville', name: 'Hôtel de Ville', address: 'Rue de Rivoli, 4e', hours: DAY_AND_NIGHT, deposits: true, latitude: 48.8573, longitude: 2.3519 },
      { id: 'paris-chatelet', name: 'Châtelet', address: 'Place du Châtelet, 1er', hours: DAY_AND_NIGHT, deposits: false, latitude: 48.8584, longitude: 2.347 },
      { id: 'paris-saint-michel', name: 'Saint-Michel', address: 'Boulevard Saint-Michel, 5e', hours: '7:00–23:00', deposits: false, latitude: 48.8534, longitude: 2.344 },
      { id: 'paris-louvre', name: 'Louvre – Rivoli', address: 'Rue de Rivoli, 1er', hours: DAY_AND_NIGHT, deposits: false, latitude: 48.8606, longitude: 2.3376 },
      { id: 'paris-bastille', name: 'Bastille', address: 'Place de la Bastille, 11e', hours: DAY_AND_NIGHT, deposits: true, latitude: 48.8532, longitude: 2.3692 },
    ],
  },
  {
    id: 'rio-de-janeiro', name: 'Rio de Janeiro', country: 'Brazil', currency: 'BRL', latitude: -22.9068, longitude: -43.1729,
    atms: [
      { id: 'rio-de-janeiro-carioca', name: 'Largo da Carioca', address: 'Avenida Rio Branco, Centro', hours: '6:00–22:00', deposits: true, latitude: -22.9068, longitude: -43.1768 },
      { id: 'rio-de-janeiro-praca-xv', name: 'Praça XV', address: 'Rua Primeiro de Março, Centro', hours: '6:00–22:00', deposits: false, latitude: -22.903, longitude: -43.174 },
      { id: 'rio-de-janeiro-cinelandia', name: 'Cinelândia', address: 'Praça Floriano, Centro', hours: '6:00–22:00', deposits: false, latitude: -22.911, longitude: -43.176 },
      { id: 'rio-de-janeiro-lapa', name: 'Arcos da Lapa', address: 'Rua Mem de Sá, Lapa', hours: '8:00–20:00', deposits: true, latitude: -22.913, longitude: -43.18 },
    ],
  },
  {
    id: 'san-francisco', name: 'San Francisco', country: 'United States', currency: 'USD', latitude: 37.7749, longitude: -122.4194,
    atms: [
      { id: 'san-francisco-van-ness', name: 'Van Ness Station', address: 'Market St & Van Ness Ave', hours: DAY_AND_NIGHT, deposits: false, latitude: 37.7752, longitude: -122.4193 },
      { id: 'san-francisco-hayes-valley', name: 'Hayes Valley', address: 'Hayes St & Octavia St', hours: '7:00–22:00', deposits: true, latitude: 37.7766, longitude: -122.4241 },
      { id: 'san-francisco-civic-center', name: 'Civic Center', address: 'UN Plaza, Market St', hours: DAY_AND_NIGHT, deposits: true, latitude: 37.7796, longitude: -122.4138 },
      { id: 'san-francisco-mission', name: 'Mission & 16th', address: 'Mission St & 16th St', hours: DAY_AND_NIGHT, deposits: false, latitude: 37.765, longitude: -122.4196 },
      { id: 'san-francisco-powell', name: 'Powell Street', address: 'Market St & Powell St', hours: DAY_AND_NIGHT, deposits: false, latitude: 37.7844, longitude: -122.4079 },
    ],
  },
  {
    id: 'sydney', name: 'Sydney', country: 'Australia', currency: 'AUD', latitude: -33.8688, longitude: 151.2093,
    atms: [
      { id: 'sydney-martin-place', name: 'Martin Place', address: 'Martin Place, Sydney', hours: DAY_AND_NIGHT, deposits: true, latitude: -33.8679, longitude: 151.2108 },
      { id: 'sydney-wynyard', name: 'Wynyard Station', address: 'George Street, Sydney', hours: DAY_AND_NIGHT, deposits: false, latitude: -33.8659, longitude: 151.2064 },
      { id: 'sydney-town-hall', name: 'Town Hall Station', address: 'George Street, Sydney', hours: DAY_AND_NIGHT, deposits: false, latitude: -33.8732, longitude: 151.2069 },
      { id: 'sydney-circular-quay', name: 'Circular Quay', address: 'Alfred Street, Sydney', hours: '6:00–24:00', deposits: false, latitude: -33.8611, longitude: 151.2108 },
      { id: 'sydney-central', name: 'Central Station', address: 'Eddy Avenue, Haymarket', hours: DAY_AND_NIGHT, deposits: true, latitude: -33.8832, longitude: 151.2069 },
    ],
  },
  {
    id: 'tokyo', name: 'Tokyo', country: 'Japan', currency: 'JPY', latitude: 35.6762, longitude: 139.6503,
    atms: [
      { id: 'tokyo-eifukucho', name: 'Eifukuchō Station', address: 'Eifuku, Suginami', hours: '7:00–23:00', deposits: false, latitude: 35.6763, longitude: 139.6435 },
      { id: 'tokyo-meidaimae', name: 'Meidaimae Station', address: 'Matsubara, Setagaya', hours: DAY_AND_NIGHT, deposits: true, latitude: 35.6686, longitude: 139.6503 },
      { id: 'tokyo-honancho', name: 'Hōnanchō Station', address: 'Hōnan, Suginami', hours: '7:00–23:00', deposits: false, latitude: 35.6835, longitude: 139.6547 },
      { id: 'tokyo-higashi-koenji', name: 'Higashi-Kōenji Station', address: 'Kōenji-minami, Suginami', hours: DAY_AND_NIGHT, deposits: false, latitude: 35.6978, longitude: 139.6577 },
      { id: 'tokyo-shinjuku', name: 'Shinjuku Station', address: 'Nishi-Shinjuku, Shinjuku', hours: DAY_AND_NIGHT, deposits: true, latitude: 35.6896, longitude: 139.7006 },
    ],
  },
  {
    id: 'warsaw', name: 'Warsaw', country: 'Poland', currency: 'PLN', latitude: 52.2297, longitude: 21.0122,
    atms: [
      { id: 'warsaw-palace-of-culture', name: 'Palace of Culture and Science', address: 'Plac Defilad, Śródmieście', hours: DAY_AND_NIGHT, deposits: true, latitude: 52.2318, longitude: 21.006 },
      { id: 'warsaw-centralna', name: 'Warszawa Centralna', address: 'Aleje Jerozolimskie, Śródmieście', hours: DAY_AND_NIGHT, deposits: false, latitude: 52.2289, longitude: 21.0033 },
      { id: 'warsaw-nowy-swiat', name: 'Nowy Świat', address: 'Nowy Świat, Śródmieście', hours: '7:00–23:00', deposits: false, latitude: 52.233, longitude: 21.0195 },
      { id: 'warsaw-plac-zbawiciela', name: 'Plac Zbawiciela', address: 'Marszałkowska, Śródmieście', hours: DAY_AND_NIGHT, deposits: true, latitude: 52.2196, longitude: 21.0147 },
      { id: 'warsaw-old-town', name: 'Old Town Market Square', address: 'Rynek Starego Miasta', hours: '8:00–22:00', deposits: false, latitude: 52.2497, longitude: 21.0122 },
    ],
  },
];
