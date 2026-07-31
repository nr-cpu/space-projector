// Earth-Centered Earth-Fixed (ECEF) positions for the orbital "zoomed out
// past the sky dome" camera — a from-space view of the same satellites and
// aircraft the ground-based dome shows, reusing the same TLE/aircraft data.
// Kilometers throughout; Three.js scene scale is applied by the renderer.

import * as satelliteNS from "satellite.js";
import { DEG, FT_TO_M } from "./constants.js";
import type { Tle } from "./celestial.js";
import type { Aircraft } from "./aircraft.js";

const satellite: typeof satelliteNS =
  (satelliteNS as unknown as { default?: typeof satelliteNS }).default ?? satelliteNS;

/** Mean equatorial radius, km (WGS84). */
export const EARTH_RADIUS_KM = 6378.137;

export interface EcefVec {
  x: number;
  y: number;
  z: number;
}

export interface OrbitalSat {
  name: string;
  isIss: boolean;
  pos: EcefVec; // ECEF, km
}

export interface OrbitalAircraft {
  hex: string;
  name: string;
  pos: EcefVec; // ECEF, km
}

const satrecCache = new Map<string, satelliteNS.SatRec>();
function getSatrec(tle: Tle): satelliteNS.SatRec | null {
  const key = tle.line1 + tle.line2;
  let rec = satrecCache.get(key);
  if (!rec) {
    try {
      rec = satellite.twoline2satrec(tle.line1, tle.line2);
    } catch {
      return null;
    }
    satrecCache.set(key, rec);
  }
  return rec;
}

/** ECEF positions (km) of every satellite with a usable TLE at `date`. */
export function orbitalSatellites(tles: Tle[], date: Date): OrbitalSat[] {
  const gmst = satellite.gstime(date);
  const out: OrbitalSat[] = [];
  for (const tle of tles) {
    const rec = getSatrec(tle);
    if (!rec) continue;
    const pv = satellite.propagate(rec, date);
    const pos = pv?.position;
    if (!pos || typeof pos === "boolean") continue;
    const ecf = satellite.eciToEcf(pos, gmst);
    out.push({
      name: tle.name.replace(/\s*\(.*\)\s*$/, "").trim(),
      isIss: /\bISS\b|\bZARYA\b/i.test(tle.name),
      pos: { x: ecf.x, y: ecf.y, z: ecf.z },
    });
  }
  return out;
}

/** ECEF position (km) of a single lat/lon/altitude(ft) point — aircraft or
 *  the ground observer's own site marker. */
export function geodeticToEcefKm(latDeg: number, lonDeg: number, altFt: number): EcefVec {
  const ecf = satellite.geodeticToEcf({
    latitude: latDeg * DEG,
    longitude: lonDeg * DEG,
    height: (altFt * FT_TO_M) / 1000, // satellite.js expects km
  });
  return { x: ecf.x, y: ecf.y, z: ecf.z };
}

/** ECEF positions (km) of aircraft that currently have a lat/lon fix. */
export function orbitalAircraft(list: Aircraft[]): OrbitalAircraft[] {
  const out: OrbitalAircraft[] = [];
  for (const ac of list) {
    if (ac.lat == null || ac.lon == null) continue;
    const altFt = ac.altBaro ?? ac.altGeom ?? 0;
    out.push({
      hex: ac.hex,
      name: ac.flight?.trim() || ac.hex.toUpperCase(),
      pos: geodeticToEcefKm(ac.lat, ac.lon, altFt),
    });
  }
  return out;
}
