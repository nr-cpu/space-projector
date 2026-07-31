// Compute the sky at a given instant + location: sun, moon (with phase), bright
// stars, and satellites/ISS. Everything is reduced to horizontal coordinates
// (azimuth from North, altitude above horizon) so the renderer can place them on
// the same circular "looking up" field as the aircraft.

import * as AstronomyNS from "astronomy-engine";
import * as satelliteNS from "satellite.js";
import { DEG } from "./constants.js";
import { STARS } from "./stars.js";
import { DEEP_STARS } from "./stars-deep.js";
import { activeShowers, type MeteorShower } from "./meteors.js";

// Both packages ship UMD/CJS bundles. Under some Node versions the ESM
// namespace only exposes `default` (the module lexer can't parse the UMD
// wrapper), so unwrap it; in browsers/bundlers the namespace works directly.
const Astronomy: typeof AstronomyNS =
  (AstronomyNS as unknown as { default?: typeof AstronomyNS }).default ?? AstronomyNS;
const satellite: typeof satelliteNS =
  (satelliteNS as unknown as { default?: typeof satelliteNS }).default ?? satelliteNS;

const R2D = 180 / Math.PI;

export type SkyKind =
  | "sun"
  | "moon"
  | "star"
  | "deepstar"
  | "satellite"
  | "iss"
  | "planet"
  | "meteor"
  | "comet";

export interface SkyBody {
  kind: SkyKind;
  name?: string;
  id?: string;
  az: number; // degrees from North, clockwise
  alt: number; // degrees above horizon
  mag?: number;
  illum?: number; // moon lit fraction 0..1
  waning?: boolean;
  /** Apparent angular velocity, degrees/second (satellites only) — lets the
   *  renderer draw a short motion trail without a second orbit propagation
   *  per object per frame. */
  velAz?: number;
  velAlt?: number;
}

/** A simulated meteor streak: a start point, a heading, and an angular length
 *  it travels across one render tick's worth of sky before expiring. */
export interface MeteorStreak {
  id: string;
  shower: string;
  /** Path endpoints, degrees (az/alt), for this instant's frame. */
  az1: number;
  alt1: number;
  az2: number;
  alt2: number;
  /** 0..1 fade-out over the streak's short lifetime. */
  alpha: number;
}

export interface Tle {
  name: string;
  line1: string;
  line2: string;
}

export interface CometElements {
  name: string;
  epochJd: number;
  e: number;
  q: number;
  i: number;
  w: number;
  om: number;
  tp: number;
  m1?: number;
  k1?: number;
}

export interface Sky {
  sun?: SkyBody;
  moon?: SkyBody;
  stars: SkyBody[];
  deepStars: SkyBody[];
  sats: SkyBody[];
  planets: SkyBody[];
  meteors: MeteorStreak[];
  comets: SkyBody[];
  /** Dense unresolved-star scatter along the galactic plane — the Milky Way
   *  reads as a texture of countless faint points (denser and warmer-toned
   *  toward the galactic center), not a smooth painted band, so this is a
   *  star field like deepStars, not a path to stroke/fill. */
  milkyWay: { az: number; alt: number; mag: number; warm: number }[];
  /** Currently-active meteor showers (for HUD/status display), highest activity first. */
  activeShowers: { name: string; fraction: number }[];
}

export interface SkyOpts {
  sun: boolean;
  moon: boolean;
  stars: boolean;
  deepStars: boolean;
  satellites: boolean;
  planets: boolean;
  meteors: boolean;
  showComets: boolean;
  milkyWay: boolean;
  magLimit: number;
  /** Faintest deep-field star magnitude to draw (independent of magLimit,
   *  which governs the small named/labeled catalog). */
  deepStarMagLimit: number;
  /** Faintest comet apparent magnitude to draw (comets are usually invisible;
   *  this keeps the layer from drawing dim clutter with no naked-eye chance). */
  cometMagLimit: number;
  tles: Tle[];
  comets: CometElements[];
}

/** Naked-eye planets, in rough order of how often they're a standout. */
const PLANETS: { body: AstronomyNS.Body; name: string }[] = [
  { body: Astronomy.Body.Venus, name: "Venus" },
  { body: Astronomy.Body.Jupiter, name: "Jupiter" },
  { body: Astronomy.Body.Mars, name: "Mars" },
  { body: Astronomy.Body.Saturn, name: "Saturn" },
  { body: Astronomy.Body.Mercury, name: "Mercury" },
];

function norm360(d: number): number {
  return ((d % 360) + 360) % 360;
}

// --- Milky Way galactic plane (J2000 equatorial pole of the galactic frame) ---
// North galactic pole: RA 192.85948°, Dec +27.12825°. Galactic center (l=0):
// RA 266.405°, Dec -28.936°. Standard IAU 1958 galactic coordinate definition.
const GAL_POLE_RA = 192.85948 * DEG;
const GAL_POLE_DEC = 27.12825 * DEG;
const GAL_CENTER_RA = 266.405 * DEG;
const GAL_CENTER_DEC = -28.936 * DEG;

/** Deterministic PRNG (mulberry32) — a fixed seed so the generated star
 *  scatter is stable across reloads/sessions rather than re-randomizing
 *  every time computeSky's module loads (which would make the band visibly
 *  jump every page refresh). */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Precomputed Milky Way star scatter — unresolved-star texture along the
 *  galactic plane, denser and brighter toward the galactic center (the
 *  bulge), thinning with perpendicular distance from the plane. This is a
 *  field of individual faint points (like a real long-exposure photo reads),
 *  not a shape — a shape is what kept rendering as a flat, hard-edged band
 *  no matter how its opacity/blend was tuned. Static: galactic orientation
 *  relative to the equatorial frame doesn't meaningfully change on any
 *  human timescale, and the PRNG seed is fixed so the scatter is stable. */
const MILKY_WAY_STARS: { ra: number; dec: number; mag: number; warm: number }[] = (() => {
  const toVec = (ra: number, dec: number): [number, number, number] => [
    Math.cos(dec) * Math.cos(ra),
    Math.cos(dec) * Math.sin(ra),
    Math.sin(dec),
  ];
  const pole = toVec(GAL_POLE_RA, GAL_POLE_DEC);
  const center = toVec(GAL_CENTER_RA, GAL_CENTER_DEC);
  // Gram-Schmidt: center' = center - (center·pole)pole, then normalize.
  const dot = center[0] * pole[0] + center[1] * pole[1] + center[2] * pole[2];
  const cPrime: [number, number, number] = [
    center[0] - dot * pole[0],
    center[1] - dot * pole[1],
    center[2] - dot * pole[2],
  ];
  const cLen = Math.hypot(cPrime[0], cPrime[1], cPrime[2]);
  const cHat: [number, number, number] = [cPrime[0] / cLen, cPrime[1] / cLen, cPrime[2] / cLen];
  // Third axis = pole × cHat, completing a right-handed frame in the plane.
  const third: [number, number, number] = [
    pole[1] * cHat[2] - pole[2] * cHat[1],
    pole[2] * cHat[0] - pole[0] * cHat[2],
    pole[0] * cHat[1] - pole[1] * cHat[0],
  ];

  const rnd = mulberry32(0xdec0de);
  // Sum of uniforms approximates a bell curve without needing Box-Muller.
  const gaussish = () => (rnd() + rnd() + rnd() + rnd() - 2) / 2; // roughly N(0,1)

  const pts: { ra: number; dec: number; mag: number; warm: number }[] = [];
  const COUNT = 3200;
  for (let i = 0; i < COUNT; i++) {
    // Longitude: uniform, but sampled more densely within ±40° of the
    // galactic center (l=0) to build up the brighter central bulge.
    const nearCenter = rnd() < 0.4;
    const lDeg = nearCenter ? gaussish() * 25 : rnd() * 360 - 180;
    const l = lDeg * DEG;

    // Perpendicular offset from the plane, degrees — tight near the
    // midplane (most stars), a long tail out to the band's visible width.
    const perpDeg = gaussish() * 5.5;
    const perp = perpDeg * DEG;

    // Rotate around the pole by l (in-plane), then tilt by perp (out of
    // plane, toward the pole).
    const px = cHat[0] * Math.cos(l) + third[0] * Math.sin(l);
    const py = cHat[1] * Math.cos(l) + third[1] * Math.sin(l);
    const pz = cHat[2] * Math.cos(l) + third[2] * Math.sin(l);
    const x = px * Math.cos(perp) + pole[0] * Math.sin(perp);
    const y = py * Math.cos(perp) + pole[1] * Math.sin(perp);
    const z = pz * Math.cos(perp) + pole[2] * Math.sin(perp);

    const dec = Math.asin(Math.max(-1, Math.min(1, z))) * R2D;
    const ra = norm360(Math.atan2(y, x) * R2D);

    // Brighter (lower mag) near the midplane and near the galactic center —
    // real dust/star density falls off both ways from the bulge.
    const centerDist = Math.abs(((lDeg + 180) % 360) - 180);
    const brightnessBoost = (nearCenter ? 1.4 : 0.6) - Math.min(1, centerDist / 60) * 0.5;
    const mag = 5.5 + gaussish() * 1.3 - brightnessBoost + Math.abs(perpDeg) * 0.12;
    // Warmth 0..1 — higher near the galactic center (real dust glow is
    // rust/gold there), cooler/neutral out in the spiral-arm sections.
    const warm = Math.max(0, Math.min(1, (nearCenter ? 0.75 : 0.25) - centerDist / 90));

    pts.push({ ra, dec, mag, warm });
  }
  return pts;
})();

/** Horizontal coords of a fixed star from its RA/Dec and the local sidereal time. */
function starAltAz(raDeg: number, decDeg: number, lstHours: number, latDeg: number) {
  const ra = raDeg * DEG;
  const dec = decDeg * DEG;
  const lat = latDeg * DEG;
  const H = (lstHours * 15) * DEG - ra; // hour angle (rad)
  const sinAlt = Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(H);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const cosAz = (Math.sin(dec) - Math.sin(alt) * Math.sin(lat)) / (Math.cos(alt) * Math.cos(lat));
  const sinAz = (-Math.sin(H) * Math.cos(dec)) / Math.cos(alt);
  const az = norm360(Math.atan2(sinAz, cosAz) * R2D);
  return { az, alt: alt * R2D };
}

function bodyAltAz(
  body: AstronomyNS.Body,
  date: Date,
  observer: AstronomyNS.Observer,
): { az: number; alt: number } {
  const eq = Astronomy.Equator(body, date, observer, true, true);
  const hor = Astronomy.Horizon(date, observer, eq.ra, eq.dec, "normal");
  return { az: hor.azimuth, alt: hor.altitude };
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

// --- Comets: two-body Keplerian propagation from JPL SBDB orbital elements ---

const GAUSS_K = 0.01720209895; // Gaussian gravitational constant, AU^1.5/day
const J2000_JD = 2451545.0;
const OBLIQUITY_J2000 = 23.4392911 * DEG;

/** Solve Kepler's equation M = E - e sin E for E (elliptical case), Newton's method. */
function solveKeplerElliptic(M: number, e: number): number {
  let E = e < 0.8 ? M : Math.PI;
  for (let i = 0; i < 30; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-10) break;
  }
  return E;
}

/** Solve the hyperbolic Kepler equation M = e sinh F - F (e > 1), Newton's method. */
function solveKeplerHyperbolic(M: number, e: number): number {
  let F = Math.log((2 * Math.abs(M)) / e + 1.8);
  if (M < 0) F = -F;
  for (let i = 0; i < 50; i++) {
    const dF = (e * Math.sinh(F) - F - M) / (e * Math.cosh(F) - 1);
    F -= dF;
    if (Math.abs(dF) < 1e-10) break;
  }
  return F;
}

/**
 * Heliocentric ecliptic position (AU, J2000) of a comet at `date`, from its
 * osculating elements. Handles both elliptical (e<1) and near-parabolic /
 * hyperbolic (e>=1, common for long-period comets) orbits.
 */
function cometHeliocentricEcliptic(c: CometElements, date: Date): [number, number, number] {
  const jd =
    J2000_JD + (date.getTime() - Date.UTC(2000, 0, 1, 12, 0, 0)) / 86400000;
  const dt = jd - c.tp; // days since perihelion passage
  const iR = c.i * DEG;
  const wR = c.w * DEG;
  const omR = c.om * DEG;

  let xOrb: number, yOrb: number;
  if (c.e < 1) {
    const a = c.q / (1 - c.e);
    const n = GAUSS_K / Math.sqrt(a ** 3); // mean motion, rad/day
    const M = n * dt;
    const E = solveKeplerElliptic(((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), c.e);
    xOrb = a * (Math.cos(E) - c.e);
    yOrb = a * Math.sqrt(1 - c.e * c.e) * Math.sin(E);
  } else {
    const a = c.q / (c.e - 1); // semi-major axis magnitude for e>1
    const n = GAUSS_K / Math.sqrt(a ** 3);
    const M = n * dt;
    const F = solveKeplerHyperbolic(M, c.e);
    xOrb = a * (c.e - Math.cosh(F));
    yOrb = -a * Math.sqrt(c.e * c.e - 1) * Math.sinh(F);
  }

  // Rotate from the orbital plane into J2000 ecliptic coordinates.
  const cosW = Math.cos(wR), sinW = Math.sin(wR);
  const cosOm = Math.cos(omR), sinOm = Math.sin(omR);
  const cosI = Math.cos(iR), sinI = Math.sin(iR);

  const xEcl =
    (cosOm * cosW - sinOm * sinW * cosI) * xOrb +
    (-cosOm * sinW - sinOm * cosW * cosI) * yOrb;
  const yEcl =
    (sinOm * cosW + cosOm * sinW * cosI) * xOrb +
    (-sinOm * sinW + cosOm * cosW * cosI) * yOrb;
  const zEcl = sinW * sinI * xOrb + cosW * sinI * yOrb;

  return [xEcl, yEcl, zEcl];
}

/** Standard comet apparent-magnitude law: m = M1 + 5 log10(delta) + K1 log10(r). */
function cometApparentMag(c: CometElements, rAu: number, deltaAu: number): number | undefined {
  if (c.m1 == null || c.k1 == null) return undefined;
  return c.m1 + 5 * Math.log10(deltaAu) + c.k1 * Math.log10(rAu);
}

/** Comet az/alt + estimated apparent magnitude, or null if elements are unusable. */
function cometAltAz(
  c: CometElements,
  date: Date,
  observer: AstronomyNS.Observer,
): { az: number; alt: number; mag?: number } | null {
  const [xh, yh, zh] = cometHeliocentricEcliptic(c, date);
  const rAu = Math.sqrt(xh * xh + yh * yh + zh * zh);
  if (!Number.isFinite(rAu) || rAu <= 0) return null;

  // Ecliptic -> equatorial (J2000), then Earth-relative (geocentric) vector.
  const cosEps = Math.cos(OBLIQUITY_J2000), sinEps = Math.sin(OBLIQUITY_J2000);
  const xEq = xh;
  const yEq = yh * cosEps - zh * sinEps;
  const zEq = yh * sinEps + zh * cosEps;

  const earth = Astronomy.HelioVector(Astronomy.Body.Earth, date);
  const gx = xEq - earth.x;
  const gy = yEq - earth.y;
  const gz = zEq - earth.z;
  const deltaAu = Math.sqrt(gx * gx + gy * gy + gz * gz);
  if (!Number.isFinite(deltaAu) || deltaAu <= 0) return null;

  const vec = new Astronomy.Vector(gx, gy, gz, Astronomy.MakeTime(date));
  const eq = Astronomy.EquatorFromVector(vec);
  const hor = Astronomy.Horizon(date, observer, eq.ra, eq.dec, "normal");
  return {
    az: hor.azimuth,
    alt: hor.altitude,
    mag: cometApparentMag(c, rAu, deltaAu),
  };
}

// --- Meteors: simulated streaks near active shower radiants ---

/** How often (ms, expected interval at ZHR=100) a streak spawns near an active
 *  radiant. Actual spawn is probabilistic per computeSky tick, scaled by the
 *  shower's current activity fraction and ZHR. */
const METEOR_BASE_INTERVAL_MS = 45_000;

/**
 * Sporadic background rate — real dark skies show a handful of meteors per
 * hour even with no named shower active (random debris, not tied to any
 * radiant). Without this, computeSky produces zero meteors on most nights of
 * the year (only ~12 short shower windows), which reads as "broken" for an
 * ambient display. Tuned brighter than the real ~5-8/hr dark-sky rate so it's
 * actually noticed rather than technically-present-but-invisible; it's still
 * a real, always-true astronomical fact (sporadics happen every night), just
 * turned up for visibility the way the satellite/star layers already are.
 */
const SPORADIC_INTERVAL_MS = 25_000; // expected interval between sporadic streaks

let meteorRngSeed = Date.now() % 2147483647;
function meteorRandom(): number {
  meteorRngSeed = (meteorRngSeed * 16807) % 2147483647;
  return (meteorRngSeed - 1) / 2147483646;
}

interface LiveMeteor {
  id: string;
  shower: string;
  az0: number;
  alt0: number;
  headingDeg: number; // direction of travel across the sky, degrees
  spawnedAt: number; // ms epoch
  lifeMs: number;
}

const liveMeteors: LiveMeteor[] = [];
let lastMeteorSpawnCheck = 0;

/** Radiant az/alt for a shower right now (may be below the horizon). */
function radiantAltAz(shower: MeteorShower, date: Date, latDeg: number, lonDeg: number) {
  const lst = Astronomy.SiderealTime(date) + lonDeg / 15;
  return starAltAz(shower.ra, shower.dec, lst, latDeg);
}

function stepMeteors(
  date: Date,
  latDeg: number,
  lonDeg: number,
  nowMs: number,
): { streaks: MeteorStreak[]; active: { name: string; fraction: number }[] } {
  const showers = activeShowers(date);

  // Spawn check: at most once per second of wall-clock, so cadence doesn't
  // depend on render frame rate.
  if (nowMs - lastMeteorSpawnCheck > 1000) {
    const elapsedFrac = (nowMs - lastMeteorSpawnCheck) / METEOR_BASE_INTERVAL_MS;
    const sporadicElapsedFrac = (nowMs - lastMeteorSpawnCheck) / SPORADIC_INTERVAL_MS;
    lastMeteorSpawnCheck = nowMs;
    for (const { shower, fraction } of showers) {
      const radiant = radiantAltAz(shower, date, latDeg, lonDeg);
      if (radiant.alt < -5) continue; // radiant well below horizon: skip
      const rate = fraction * (shower.zhr / 100);
      if (meteorRandom() < rate * elapsedFrac) {
        // Streak starts a random offset from the radiant and travels outward.
        const spreadDeg = 25 + meteorRandom() * 35;
        const bearingFromRadiant = meteorRandom() * 360;
        const startAz = norm360(radiant.az + Math.sin(bearingFromRadiant * DEG) * spreadDeg);
        const startAlt = Math.max(2, radiant.alt + Math.cos(bearingFromRadiant * DEG) * spreadDeg);
        liveMeteors.push({
          id: `${shower.id}-${nowMs}-${Math.floor(meteorRandom() * 1e6)}`,
          shower: shower.name,
          az0: startAz,
          alt0: startAlt,
          headingDeg: bearingFromRadiant, // radial outward from the radiant
          spawnedAt: nowMs,
          lifeMs: 220 + meteorRandom() * 260, // a real meteor streak is brief
        });
      }
    }
    // Sporadics: no radiant, no shower — a random meteor anywhere above the
    // horizon, traveling a random direction. Real, nightly, background rate.
    if (meteorRandom() < sporadicElapsedFrac) {
      const startAz = meteorRandom() * 360;
      const startAlt = 15 + meteorRandom() * 60;
      const heading = meteorRandom() * 360;
      liveMeteors.push({
        id: `sporadic-${nowMs}-${Math.floor(meteorRandom() * 1e6)}`,
        shower: "sporadic",
        az0: startAz,
        alt0: startAlt,
        headingDeg: heading,
        spawnedAt: nowMs,
        lifeMs: 220 + meteorRandom() * 260,
      });
    }
  }

  const streaks: MeteorStreak[] = [];
  for (let idx = liveMeteors.length - 1; idx >= 0; idx--) {
    const m = liveMeteors[idx];
    const age = nowMs - m.spawnedAt;
    if (age > m.lifeMs) {
      liveMeteors.splice(idx, 1);
      continue;
    }
    const t0 = age / m.lifeMs;
    const t1 = Math.min(1, (age + 16) / m.lifeMs); // ~one frame's travel
    const travelDeg = 18; // angular length traversed over the full streak life
    const d0 = t0 * travelDeg;
    const d1 = t1 * travelDeg;
    const rad = m.headingDeg * DEG;
    streaks.push({
      id: m.id,
      shower: m.shower,
      az1: norm360(m.az0 + Math.sin(rad) * d0),
      alt1: m.alt0 + Math.cos(rad) * d0,
      az2: norm360(m.az0 + Math.sin(rad) * d1),
      alt2: m.alt0 + Math.cos(rad) * d1,
      alpha: 1 - t0,
    });
  }

  return {
    streaks,
    active: showers.map((s) => ({ name: s.shower.name, fraction: s.fraction })),
  };
}

export function computeSky(date: Date, latDeg: number, lonDeg: number, o: SkyOpts): Sky {
  const observer = new Astronomy.Observer(latDeg, lonDeg, 0);
  const sky: Sky = {
    stars: [],
    deepStars: [],
    sats: [],
    planets: [],
    meteors: [],
    comets: [],
    milkyWay: [],
    activeShowers: [],
  };

  if (o.sun) {
    const { az, alt } = bodyAltAz(Astronomy.Body.Sun, date, observer);
    sky.sun = { kind: "sun", az, alt };
  }
  if (o.moon) {
    const { az, alt } = bodyAltAz(Astronomy.Body.Moon, date, observer);
    const illum = Astronomy.Illumination(Astronomy.Body.Moon, date);
    const phase = Astronomy.MoonPhase(date); // 0..360, 180 = full
    sky.moon = { kind: "moon", az, alt, illum: illum.phase_fraction, waning: phase > 180 };
  }
  if (o.stars || o.deepStars) {
    const lst = Astronomy.SiderealTime(date) + lonDeg / 15; // local sidereal hours
    if (o.stars) {
      for (const s of STARS) {
        if (s.mag > o.magLimit) continue;
        const { az, alt } = starAltAz(s.ra, s.dec, lst, latDeg);
        if (alt < -2) continue; // below horizon
        sky.stars.push({ kind: "star", id: s.id, name: s.name, az, alt, mag: s.mag });
      }
    }
    if (o.deepStars) {
      for (const s of DEEP_STARS) {
        if (s.mag > o.deepStarMagLimit) continue;
        const { az, alt } = starAltAz(s.ra, s.dec, lst, latDeg);
        if (alt < -2) continue; // below horizon
        sky.deepStars.push({ kind: "deepstar", id: s.id, az, alt, mag: s.mag });
      }
    }
  }
  if (o.milkyWay) {
    const lst = Astronomy.SiderealTime(date) + lonDeg / 15;
    for (const s of MILKY_WAY_STARS) {
      const { az, alt } = starAltAz(s.ra, s.dec, lst, latDeg);
      if (alt < -2) continue;
      sky.milkyWay.push({ az, alt, mag: s.mag, warm: s.warm });
    }
  }
  if (o.meteors) {
    const { streaks, active } = stepMeteors(date, latDeg, lonDeg, Date.now());
    sky.meteors = streaks;
    sky.activeShowers = active;
  }
  if (o.showComets && o.comets.length) {
    for (const c of o.comets) {
      const hit = cometAltAz(c, date, observer);
      if (!hit || hit.alt < -2) continue;
      // No brightness parameters (m1/k1) on record for this comet: treat as
      // unknown-and-faint rather than assume it's visible. Roughly half of
      // JPL's comet catalog lacks these, mostly long-dead/never-recovered
      // ones with no modern photometry — showing them all unfiltered is
      // how thousands of long-extinct comet designations end up drawn.
      if (hit.mag == null || hit.mag > o.cometMagLimit) continue;
      sky.comets.push({
        kind: "comet",
        name: c.name.replace(/^\s*\d*[A-Z]?\/?/, "").trim() || c.name.trim(),
        az: norm360(hit.az),
        alt: hit.alt,
        mag: hit.mag,
      });
    }
  }
  if (o.satellites && o.tles.length) {
    const gmst = satellite.gstime(date);
    const observerGd = {
      longitude: lonDeg * DEG,
      latitude: latDeg * DEG,
      height: 0,
    };
    // Small look-ahead for an analytic angular velocity (trail direction +
    // speed) without a second full sky computation — one extra propagate()
    // per satellite, same cost class as the position call itself.
    const VEL_DT_S = 2;
    const dateAhead = new Date(date.getTime() + VEL_DT_S * 1000);
    const gmstAhead = satellite.gstime(dateAhead);
    for (const tle of o.tles) {
      const rec = getSatrec(tle);
      if (!rec) continue;
      const pv = satellite.propagate(rec, date);
      const pos = pv?.position;
      if (!pos || typeof pos === "boolean") continue;
      const ecf = satellite.eciToEcf(pos, gmst);
      const look = satellite.ecfToLookAngles(observerGd, ecf);
      const alt = look.elevation * R2D;
      if (alt < 0) continue; // below horizon
      const az = norm360(look.azimuth * R2D);

      let velAz: number | undefined;
      let velAlt: number | undefined;
      const pvAhead = satellite.propagate(rec, dateAhead);
      const posAhead = pvAhead?.position;
      if (posAhead && typeof posAhead !== "boolean") {
        const ecfAhead = satellite.eciToEcf(posAhead, gmstAhead);
        const lookAhead = satellite.ecfToLookAngles(observerGd, ecfAhead);
        const altAhead = lookAhead.elevation * R2D;
        const azAhead = norm360(lookAhead.azimuth * R2D);
        // Shortest-path azimuth delta (handles the 359°->1° wrap).
        const dAz = ((azAhead - az + 540) % 360) - 180;
        velAz = dAz / VEL_DT_S;
        velAlt = (altAhead - alt) / VEL_DT_S;
      }

      const isISS = /\bISS\b|\bZARYA\b/i.test(tle.name);
      sky.sats.push({
        kind: isISS ? "iss" : "satellite",
        name: tle.name.replace(/\s*\(.*\)\s*$/, "").trim(),
        az,
        alt,
        velAz,
        velAlt,
      });
    }
  }
  if (o.planets) {
    for (const p of PLANETS) {
      const { az, alt } = bodyAltAz(p.body, date, observer);
      if (alt < -2) continue; // below horizon
      // True apparent visual magnitude drives the on-screen size/glow.
      let mag = 0;
      try {
        mag = Astronomy.Illumination(p.body, date).mag;
      } catch {
        // Illumination can throw for a body at an unusual geometry; skip mag.
      }
      sky.planets.push({ kind: "planet", name: p.name, az, alt, mag });
    }
  }
  return sky;
}

/** Find the next time the ISS rises above `minAlt` degrees, scanning forward. */
export function nextISSPass(
  fromMs: number,
  latDeg: number,
  lonDeg: number,
  tles: Tle[],
  minAlt = 10,
  horizonHours = 12,
): number | null {
  const iss = tles.find((t) => /\bISS\b|\bZARYA\b/i.test(t.name));
  if (!iss) return null;
  const rec = getSatrec(iss);
  if (!rec) return null;
  const observerGd = { longitude: lonDeg * DEG, latitude: latDeg * DEG, height: 0 };
  const stepMs = 30_000;
  for (let t = fromMs + stepMs; t < fromMs + horizonHours * 3600_000; t += stepMs) {
    const date = new Date(t);
    const pv = satellite.propagate(rec, date);
    const pos = pv?.position;
    if (!pos || typeof pos === "boolean") continue;
    const ecf = satellite.eciToEcf(pos, satellite.gstime(date));
    const alt = satellite.ecfToLookAngles(observerGd, ecf).elevation * R2D;
    if (alt >= minAlt) return t;
  }
  return null;
}
