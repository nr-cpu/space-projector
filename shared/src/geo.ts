// Pure geo/projection math. No DOM, no state — shared by display + server.

import type { ProjectionMode } from "./config.js";

import { DEG, FT_TO_M, KT_TO_MS, MI_TO_M } from "./constants.js";

export interface Meters {
  east: number;
  north: number;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Flat-earth approximation of lat/lon -> local meters relative to a center.
 * Plenty accurate within a few miles.
 */
export function llToMeters(
  lat: number,
  lon: number,
  lat0: number,
  lon0: number,
): Meters {
  const east = (lon - lon0) * Math.cos(lat0 * DEG) * 111320;
  const north = (lat - lat0) * 110540;
  return { east, north };
}

/** Horizontal ground distance (meters) from center. */
export function rangeMeters(m: Meters): number {
  return Math.hypot(m.east, m.north);
}

export function metersToMiles(m: number): number {
  return m / MI_TO_M;
}

/** Pixels per meter so that `radiusMiles` fills half of the smaller screen axis. */
export function pxPerMeter(
  screenW: number,
  screenH: number,
  radiusMiles: number,
): number {
  return Math.min(screenW, screenH) / 2 / (radiusMiles * MI_TO_M);
}

export interface ProjectOpts {
  rotationDeg: number;
  mirrorX: boolean;
  mirrorY: boolean;
  pxPerM: number;
  screenW: number;
  screenH: number;
}

/** Local meters -> screen pixels with rotation + mirror, screen-Y inverted. */
export function project(m: Meters, o: ProjectOpts): Point {
  const t = o.rotationDeg * DEG;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  let x = m.east * cos - m.north * sin;
  let y = m.east * sin + m.north * cos;
  if (o.mirrorX) x = -x;
  if (o.mirrorY) y = -y;
  return {
    x: o.screenW / 2 + x * o.pxPerM,
    y: o.screenH / 2 - y * o.pxPerM, // screen Y grows downward
  };
}

/**
 * Dead-reckon a position forward along its track at ground speed.
 * Returns new local meters. Used to smooth ~1 Hz updates to 60 fps.
 */
export function deadReckon(
  m: Meters,
  trackDeg: number | undefined,
  gsKt: number | undefined,
  dtSec: number,
): Meters {
  if (trackDeg == null || gsKt == null || gsKt <= 0) return m;
  const dist = gsKt * KT_TO_MS * dtSec;
  const t = trackDeg * DEG;
  return {
    east: m.east + dist * Math.sin(t),
    north: m.north + dist * Math.cos(t),
  };
}

export const EMERGENCY_SQUAWKS = new Set(["7500", "7600", "7700"]);

/** Horizontal sky coordinates relative to the observer (zenith = center). */
export interface SkyAngles {
  /** Degrees from true North, clockwise. */
  az: number;
  /** Degrees above the mathematical horizon. */
  elev: number;
  /** Horizontal ground range from observer, meters. */
  groundM: number;
  /** Line-of-sight distance observer → aircraft, meters. */
  slantM: number;
}

/** Interpolated ground fix used by the renderer motion model. */
export interface GroundSample {
  m: Meters;
  altFt: number;
}

/** Horizon radius in meters (maps to the edge of the circular sky field). */
export function horizonRadiusM(radiusMiles: number): number {
  return radiusMiles * MI_TO_M;
}

/**
 * Observer at ground level → apparent sky position of an aircraft.
 * Uses flat-earth for bearing (accurate within a few miles) and right-triangle
 * elevation from horizontal range + altitude. Near zenith, `fallbackAz` (e.g.
 * track) stabilizes the singularity.
 */
export function groundToSkyAngles(
  m: Meters,
  altFt: number,
  fallbackAz?: number,
): SkyAngles {
  const groundM = rangeMeters(m);
  const h = Math.max(0, altFt) * FT_TO_M;

  let elev: number;
  let az: number;

  if (groundM < 0.5) {
    elev = 89.5;
    az = fallbackAz ?? 0;
  } else {
    elev = Math.atan2(h, groundM) * (180 / Math.PI);
    az = normAz(Math.atan2(m.east, m.north) * (180 / Math.PI));
  }

  const slantM = Math.hypot(groundM, h);
  return { az, elev, groundM, slantM };
}

/** Radial distance on the sky dome for a given elevation (90° = zenith = 0). */
export function skyElevToRadius(elevDeg: number, horizonRadius: number): number {
  const e = Math.max(0, Math.min(90, elevDeg));
  return (1 - e / 90) * horizonRadius;
}

/** Sky angles → local east/north on the dome (before calibration rotation). */
export function skyAnglesToMeters(angles: SkyAngles, horizonRadius: number): Meters {
  const r = skyElevToRadius(angles.elev, horizonRadius);
  const a = angles.az * DEG;
  return { east: Math.sin(a) * r, north: Math.cos(a) * r };
}

/**
 * Project an aircraft fix to screen pixels. In sky mode, ground position and
 * altitude are converted to azimuth/elevation on the look-up dome so apparent
 * angular speed matches what you see outdoors. `zoomView`, when given,
 * re-centers/magnifies the same way the celestial layer's zoom/pan does
 * (projectSkyPointZoomed) — omit it (or leave zoom at 1) for the unzoomed
 * legacy behavior other callers (e.g. camera calibration) rely on.
 */
export function projectAircraft(
  sample: GroundSample,
  mode: ProjectionMode,
  o: ProjectOpts,
  horizonRadius: number,
  fallbackAz?: number,
  zoomView?: { panAz: number; panAlt: number; zoom: number },
): Point {
  if (mode === "map") return project(sample.m, o);
  const sky = groundToSkyAngles(sample.m, sample.altFt, fallbackAz);
  if (zoomView && zoomView.zoom > 1) {
    return projectSkyPointZoomed(sky.az, sky.elev, zoomView.panAz, zoomView.panAlt, zoomView.zoom, o, horizonRadius);
  }
  return project(skyAnglesToMeters(sky, horizonRadius), o);
}

/** Project a celestial / horizon point (azimuth + elevation) to screen pixels. */
export function projectSkyPoint(
  azDeg: number,
  elevDeg: number,
  o: ProjectOpts,
  horizonRadius: number,
): Point {
  const r = skyElevToRadius(elevDeg, horizonRadius);
  const a = azDeg * DEG;
  return project({ east: Math.sin(a) * r, north: Math.cos(a) * r }, o);
}

/**
 * Angular separation between two sky points (degrees), spherical law of
 * cosines. Used to re-center the sky dome on a pan target and to decide
 * what's "near" for satellite label decluttering.
 */
export function angularSeparationDeg(
  az1: number,
  alt1: number,
  az2: number,
  alt2: number,
): number {
  const a1 = alt1 * DEG, a2 = alt2 * DEG;
  const dAz = (az2 - az1) * DEG;
  const cosD = Math.sin(a1) * Math.sin(a2) + Math.cos(a1) * Math.cos(a2) * Math.cos(dAz);
  return Math.acos(Math.max(-1, Math.min(1, cosD))) * (180 / Math.PI);
}

/**
 * Re-center + zoom a sky point around a pan target, for the zoomable sky
 * dome. `panAz`/`panAlt` become the new center of the field; `zoom` scales
 * radius outward from there (1 = whole-hemisphere view, same as
 * projectSkyPoint; >1 magnifies the region around the pan target).
 *
 * Rotates the point into a frame where the pan target sits at the zenith
 * (bearing/distance from the pan target, via the spherical law of cosines +
 * four-quadrant bearing), so panning to any sky point re-centers correctly
 * near the horizon too, not just near zenith.
 */
export function projectSkyPointZoomed(
  azDeg: number,
  elevDeg: number,
  panAz: number,
  panAlt: number,
  zoom: number,
  o: ProjectOpts,
  horizonRadius: number,
): Point {
  if (zoom <= 1 && panAz === 0 && panAlt === 90) {
    return projectSkyPoint(azDeg, elevDeg, o, horizonRadius);
  }
  const distDeg = angularSeparationDeg(panAz, panAlt, azDeg, elevDeg);
  // Bearing from the pan target to this point, so it maps to the correct
  // direction outward from the new center.
  const panAltR = panAlt * DEG, elevR = elevDeg * DEG;
  const dAz = (azDeg - panAz) * DEG;
  const y = Math.sin(dAz) * Math.cos(elevR);
  const x =
    Math.cos(panAltR) * Math.sin(elevR) -
    Math.sin(panAltR) * Math.cos(elevR) * Math.cos(dAz);
  const bearing = Math.atan2(y, x);

  // Re-expressed as az/alt around a zenith-centered field, then zoomed.
  // Clamp to the zoomed field's own horizon (alt >= 0): distDeg*zoom can
  // exceed 90 for anything outside the zoomed view, and left unclamped that
  // pushes `alt` deeply negative — skyElevToRadius clamps internally, but a
  // point far off one edge of the zoomed view and a point far off the
  // OPPOSITE edge both collapse toward the same clamped radius, which turns
  // a curve/line that legitimately exits the zoomed field into a jump
  // straight across the canvas instead of just running off the edge.
  const alt = Math.max(0, 90 - distDeg * zoom);
  const az = bearing * (180 / Math.PI);
  const r = skyElevToRadius(alt, horizonRadius);
  const a = az * DEG;
  return project({ east: Math.sin(a) * r, north: Math.cos(a) * r }, o);
}

/** Whether a sky point at (az, elev) falls within the zoomed field's own
 *  horizon around (panAz, panAlt) — i.e. projectSkyPointZoomed places it at
 *  a real position rather than clamped to the field's edge. Callers drawing
 *  multi-point paths (destination arcs, the Milky Way band) should break
 *  the path rather than connect a real point to a clamped one. */
export function inZoomedSkyField(
  azDeg: number,
  elevDeg: number,
  panAz: number,
  panAlt: number,
  zoom: number,
): boolean {
  if (zoom <= 1) return true;
  return angularSeparationDeg(panAz, panAlt, azDeg, elevDeg) * zoom <= 90;
}

/**
 * Subtle slant-range size scale for sky mode — nearer / lower aircraft read
 * slightly larger, matching outdoor perspective. Clamped for stability.
 */
export function skyGlyphScale(slantM: number, refSlantM = 4500): number {
  return Math.max(0.72, Math.min(1.38, refSlantM / Math.max(slantM, 400)));
}

/** Shortest-path interpolate between two azimuths, degrees. */
export function lerpAzimuth(a: number, b: number, t: number): number {
  let d = ((b - a + 540) % 360) - 180;
  return normAz(a + d * t);
}

function normAz(deg: number): number {
  return ((deg % 360) + 360) % 360;
}
