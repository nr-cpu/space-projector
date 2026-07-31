// Airport runway geometry, drawn on the ceiling at true geographic position
// so departures and arrivals visibly line up with the runways. KSUS ships as
// this fork's default; any other airport can be imported from the control
// panel by ICAO/IATA code (the server resolves it from the OurAirports
// dataset — the same source these default coordinates came from).

export interface Runway {
  leIdent: string;
  heIdent: string;
  le: [number, number]; // [lat, lon]
  he: [number, number];
  widthFt: number;
}

export interface Airport {
  icao: string;
  /** Short label drawn at the runway centroid (IATA code when known). */
  name: string;
  /** Official name, shown in the control panel. */
  fullName?: string;
  lat: number;
  lon: number;
  runways: Runway[];
}

/** Coordinates from OurAirports (KSUS — Spirit of St. Louis Airport,
 *  Chesterfield, MO). */
export const DEFAULT_AIRPORT: Airport = {
  icao: "KSUS",
  name: "SUS",
  fullName: "Spirit of St Louis Airport",
  lat: 38.662102,
  lon: -90.652,
  runways: [
    { leIdent: "08L", heIdent: "26R", le: [38.664100646972656, -90.66829681396484], he: [38.66699981689453, -90.6511001586914], widthFt: 75 },
    { leIdent: "08R", heIdent: "26L", le: [38.65769958, -90.65969849], he: [38.66189957, -90.6341018], widthFt: 150 },
  ],
};
