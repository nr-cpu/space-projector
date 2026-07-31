// Canvas renderer — the art piece.
//
// Motion model: every fix is stamped with its local arrival time and pushed to a
// per-aircraft history. We render the world RENDER_DELAY_MS in the past and
// *interpolate* between the two surrounding real fixes (rather than extrapolating
// into the future). Interpolating between known points is buttery smooth and
// removes the once-per-second "snap" you get from naive dead-reckoning. The small
// added latency is irrelevant for an ambient ceiling piece.
//
// Sky projection (projectionMode = "sky"): each fix is converted from ground
// position + altitude to azimuth/elevation on a look-up hemisphere (zenith =
// center, horizon = edge). Interpolation happens in ground space, then the
// trig mapping runs every frame so apparent angular speed matches lying outside
// and watching the real sky — fast overhead, slow at the horizon.
//
// Visual language: pure black, luminous altitude-graded glyphs, comet trails that
// taper and fade, and restrained typography that fades in only for the nearest few.

import {
  llToMeters,
  project,
  pxPerMeter,
  convertDistance,
  deadReckon,
  rangeMeters,
  metersToMiles,
  formatSpeed,
  formatAltitude,
  formatDistance,
  horizonRadiusM,
  groundToSkyAngles,
  projectAircraft,
  projectSkyPoint,
  projectSkyPointZoomed,
  angularSeparationDeg,
  inZoomedSkyField,
  skyGlyphScale,
  lerpAzimuth,
  DEG,
  EMERGENCY_SQUAWKS,
  bearing,
  greatCircleMiles,
  routePlausible,
  FT_TO_M,
  KM_TO_M,
  MI_TO_M,
  type Aircraft,
  type Config,
  type GroundSample,
  type Meters,
  type Point,
  type SkyAngles,
} from "@shared/index.js";
import { classifyGlyph, drawAircraftGlyph, GLYPH_SCALE } from "./aircraftGlyph.js";
import { computeSky, type Sky, type Tle, type CometElements } from "./celestial.js";
import { visibleAsterisms } from "./stars.js";
import tzLookup from "tz-lookup";

/** How far in the past we render, ms. Just over the ~1 Hz fix interval. */
const RENDER_DELAY_MS = 1150;

/** Characteristic tints for the naked-eye planets, as "r,g,b". */
const PLANET_COLORS: Record<string, string> = {
  Venus: "255,244,214",
  Jupiter: "245,226,184",
  Mars: "232,131,90",
  Saturn: "232,217,160",
  Mercury: "200,192,176",
};

/** Screen radius for a planet glyph from its magnitude. */
function planetDrawSize(mag: number): number {
  return Math.max(1.6, Math.min(4, 3 - mag * 0.5));
}

/** Screen radius for a star glyph from its magnitude. */
function starDrawSize(mag: number): number {
  return Math.max(0.6, 2.6 - mag * 0.7);
}

/** Gap between sky-object edge and label anchor, px. */
const SKY_LABEL_GAP = 4;

/** Radius of each overlapping glow blob composing the Milky Way band, px.
 *  Scales with screen size elsewhere would be nicer, but a fixed value tuned
 *  for a ~1080p display keeps the drawMilkyWay loop simple; revisit if the
 *  band reads too thin/thick on very different resolutions. */
const MILKY_WAY_BAND_PX = 90;

interface SkyLabelEntry {
  p: Point;
  name: string;
  color: string;
  size: number;
  alpha: number;
  /** Lower = brighter / more important; gets the preferred slot first. */
  priority: number;
}

interface Sample {
  t: number; // performance.now() at arrival
  m: Meters;
  altFt: number;
  track?: number;
  gs?: number;
}

/** A hoverable on-screen thing, rebuilt fresh every frame. hitTest() picks
 *  the nearest one within its radius; short-label callers keep it to 1-2
 *  words so the tooltip doesn't compete with the sky itself. */
interface HoverTarget {
  x: number;
  y: number;
  r: number; // hit-test radius, px
  label: string;
}

interface Track {
  ac: Aircraft;
  history: Sample[];
  firstSeen: number;
  lastSeen: number;
  hasPos: boolean;
  /** Smoothed appearance alpha (fade in on spawn, out when stale). */
  life: number;
  /** Eased on-screen glyph heading (rad), so track updates rotate smoothly. */
  headingSmooth?: number;
}

type ProjOpts = Parameters<typeof project>[1];

// Altitude colour ramp — warm low, cool high. Tuned to glow on black.
const ALT_STOPS: [number, [number, number, number]][] = [
  [0, [255, 138, 61]], // amber (ground / pattern)
  [4000, [255, 198, 92]], // gold
  [10000, [120, 224, 196]], // teal
  [20000, [110, 178, 255]], // sky blue
  [30000, [150, 150, 255]], // periwinkle
  [40000, [232, 236, 255]], // near-white
];

function altRamp(alt: number): [number, number, number] {
  if (alt <= ALT_STOPS[0][0]) return ALT_STOPS[0][1];
  for (let i = 1; i < ALT_STOPS.length; i++) {
    if (alt <= ALT_STOPS[i][0]) {
      const [a0, c0] = ALT_STOPS[i - 1];
      const [a1, c1] = ALT_STOPS[i];
      const f = (alt - a0) / (a1 - a0);
      return [
        c0[0] + (c1[0] - c0[0]) * f,
        c0[1] + (c1[1] - c0[1]) * f,
        c0[2] + (c1[2] - c0[2]) * f,
      ];
    }
  }
  return ALT_STOPS[ALT_STOPS.length - 1][1];
}

export function labelLines(cfg: Config, ac: Aircraft): { text: string; kind: "title" | "sub" }[] {
  const f = cfg.showFields;
  const out: { text: string; kind: "title" | "sub" }[] = [];

  const title = f.name ?
      cfg.nameDisplay === "flight" ?
        ac.flight ?? ac.hex.toUpperCase() :
        ac.airline
    : null;
  if (title) out.push({ text: title, kind: "title" });

  const sub: string[] = [];
  if (f.type && (ac.typeName || ac.typeCode)) sub.push(ac.typeName ?? ac.typeCode!);
  const alt = ac.altBaro ?? ac.altGeom;
  if (f.altitude) {
    if (ac.onGround) sub.push("GND");
    else if (alt != null) sub.push(formatAltitude(alt, cfg.altitudeUnit));
  }
  if (f.speed && ac.gs != null) sub.push(formatSpeed(ac.gs, cfg.speedUnit));
  if (sub.length) out.push({ text: sub.join("   "), kind: "sub" });

  if (f.destination && ac.destination && routePlausible(ac, cfg)) {
    const origin = cfg?.locationDisplay === "name" && ac.originName ? ac.originName : ac.origin ?? "";
    const destination = cfg?.locationDisplay === "name" && ac.destName ? ac.destName : ac.destination ?? "";
    out.push({ text: [origin, destination].join(' → '), kind: "sub" });

    if (cfg.showRouteDetail && ac.destLat != null && ac.destLon != null) {
      const bits: string[] = [`${localTimeAt(ac.destLat, ac.destLon)} local`];
      if (ac.lat != null && ac.lon != null) {
        const mi = Math.round(greatCircleMiles(ac.lat, ac.lon, ac.destLat, ac.destLon));
        if (mi > 1) bits.push(`${formatDistance(mi, cfg.distanceUnit)} to go`);
      }
      out.push({ text: bits.join("   ·   "), kind: "sub" });
    }
  }
  if (f.registration && ac.registration) out.push({ text: ac.registration, kind: "sub" });
  return out;
}

const rgba = (c: [number, number, number], a: number) =>
  `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

interface Visible {
  tr: Track;
  sample: GroundSample;
  sky: SkyAngles | null;
  p: Point;
  heading: number;
  rangeMi: number;
  alpha: number;
  color: [number, number, number];
  emergency: boolean;
  sizeScale: number;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private tracks = new Map<string, Track>();
  private raf = 0;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private prevFrame = 0;
  /** When the next frame is due (ms, rAF clock), for the maxFps cap.
   *  0 = uninitialized; set on the first capped frame. */
  private nextFrameDue = 0;
  /** Current frame time in seconds, for animating props/rotors. */
  private frameT = 0;

  /** Hoverable on-screen things, rebuilt every frame — see hitTest(). */
  private hoverTargets: HoverTarget[] = [];

  // --- idle auto-drift ("screensaver" satellite watching) ---
  /** rAF-clock timestamp of the last user interaction (zoom/pan/hover). */
  private lastInteractionAt = performance.now();
  /** Currently-animated effective zoom/pan while idle-drifting; null = use
   *  the real config values directly (either not idle yet, or no target). */
  private driftZoom: number | null = null;
  private driftPanAz = 0;
  private driftPanAlt = 90;
  private driftTargetAz = 0;
  private driftTargetAlt = 90;
  private driftHoldUntil = 0;
  /** This frame's effective (zoom, panAz, panAlt) — computed once per draw()
   *  call so projectSky/inSkyView (called many times per frame) don't each
   *  recompute the idle-drift ease. */
  private frameView = { zoom: 1, panAz: 0, panAlt: 90 };
  /** Target zoom for the current drift hold — picked once per target (see
   *  pickDriftZoom), not per frame. */
  private driftTargetZoom = 8;

  // Sky layer state.
  private tles: Tle[] = [];
  private comets: CometElements[] = [];
  private sky: Sky = {
    stars: [],
    deepStars: [],
    sats: [],
    planets: [],
    meteors: [],
    comets: [],
    milkyWay: [],
    activeShowers: [],
  };
  private skyComputedAt = 0;
  private skyOffsetUsed = NaN;

  /** When the source went down (rAF clock), null while healthy. While down,
   *  the staleness clock pauses so a transient fetch failure doesn't wipe the
   *  sky and re-spawn everything seconds later (#24). */
  private sourceDownAt: number | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private getConfig: () => Config,
  ) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    this.resize();
  }

  start(): void {
    void this.fetchTles();
    void this.fetchComets();
    setInterval(() => void this.fetchTles(), 3600_000);
    setInterval(() => void this.fetchComets(), 6 * 3600_000);
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      // Cap to maxFps via an accumulator: advance a running "due" time by whole
      // frame intervals so the cadence stays anchored to a schedule (even
      // pacing, no drift) rather than to actual draw timestamps. fps <= 0 means
      // uncapped — draw on every rAF tick.
      const fps = this.getConfig().maxFps;
      if (fps > 0) {
        const interval = 1000 / fps;
        if (this.nextFrameDue === 0) this.nextFrameDue = now;
        if (now < this.nextFrameDue) return; // not due yet — skip this tick
        this.nextFrameDue += interval;
        // If we've fallen more than a frame behind (e.g. tab was backgrounded
        // or a draw stalled), resync to avoid a burst of catch-up frames.
        if (now - this.nextFrameDue > interval) this.nextFrameDue = now + interval;
      } else {
        this.nextFrameDue = 0; // reset so re-enabling the cap starts clean
      }
      this.draw();
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Current TLE set (already fetched/cached here) — reused by the orbital
   *  pullback view so it isn't a second independent poller of /api/tle. */
  getTles(): Tle[] {
    return this.tles;
  }

  private async fetchTles(): Promise<void> {
    try {
      const res = await fetch("/api/tle");
      if (res.ok) this.tles = (await res.json()) as Tle[];
    } catch {
      /* keep whatever we had */
    }
  }

  private async fetchComets(): Promise<void> {
    try {
      const res = await fetch("/api/comets");
      if (res.ok) this.comets = (await res.json()) as CometElements[];
    } catch {
      /* keep whatever we had */
    }
  }
  stop(): void {
    cancelAnimationFrame(this.raf);
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /** Source health from server status messages. */
  setSourceOk(ok: boolean): void {
    if (ok) this.sourceDownAt = null;
    else this.sourceDownAt ??= performance.now();
  }

  /** Feed a fresh snapshot. Stamps each fix with local arrival time. */
  update(aircraft: Aircraft[]): void {
    const cfg = this.getConfig();
    const now = performance.now();
    for (const ac of aircraft) {
      if (!this.passesFilter(ac, cfg)) continue;
      const hasPos = ac.lat != null && ac.lon != null;
      const m = hasPos
        ? llToMeters(ac.lat!, ac.lon!, cfg.centerLat, cfg.centerLon)
        : { east: 0, north: 0 };
      const altFt = ac.altBaro ?? ac.altGeom ?? 0;
      let tr = this.tracks.get(ac.hex);
      if (!tr) {
        tr = { ac, history: [], firstSeen: now, lastSeen: now, hasPos, life: 0 };
        this.tracks.set(ac.hex, tr);
      }
      tr.ac = ac;
      tr.lastSeen = now;
      tr.hasPos = hasPos;
      if (hasPos) {
        const last = tr.history[tr.history.length - 1];
        // Dedup identical fixes (source sometimes repeats a position).
        if (
          !last ||
          last.m.east !== m.east ||
          last.m.north !== m.north ||
          last.altFt !== altFt
        ) {
          tr.history.push({ t: now, m, altFt, track: ac.track, gs: ac.gs });
        }
      }
    }
  }

  private passesFilter(ac: Aircraft, cfg: Config): boolean {
    if (!cfg.showAircraft) return false;
    if (cfg.hideOnGround && ac.onGround) return false;
    const alt = ac.altBaro ?? ac.altGeom;
    if (alt != null) {
      if (alt < cfg.minAltitudeFt) return false;
      if (alt > cfg.maxAltitudeFt) return false;
    }
    return true;
  }

  /** Interpolate a track's ground fix (+ altitude) at render time `tt`. */
  private sampleAt(tr: Track, tt: number, cfg: Config): GroundSample | null {
    const h = tr.history;
    if (h.length === 0) return null;
    if (tt <= h[0].t) return { m: h[0].m, altFt: h[0].altFt };
    const lastS = h[h.length - 1];
    if (tt >= lastS.t) {
      const dt = Math.min((tt - lastS.t) / 1000, cfg.maxExtrapolationSec);
      const m = cfg.interpolate
        ? deadReckon(lastS.m, lastS.track, lastS.gs, dt)
        : lastS.m;
      const vr = tr.ac.baroRate ?? 0;
      const altFt = lastS.altFt + (vr / 60) * dt;
      return { m, altFt };
    }
    for (let i = h.length - 1; i > 0; i--) {
      if (h[i - 1].t <= tt && tt <= h[i].t) {
        const a = h[i - 1];
        const b = h[i];
        const f = (tt - a.t) / Math.max(1, b.t - a.t);
        return {
          m: {
            east: a.m.east + (b.m.east - a.m.east) * f,
            north: a.m.north + (b.m.north - a.m.north) * f,
          },
          altFt: a.altFt + (b.altFt - a.altFt) * f,
        };
      }
    }
    return { m: lastS.m, altFt: lastS.altFt };
  }

  private horizonM(cfg: Config): number {
    return horizonRadiusM(cfg.radiusMiles);
  }

  /** Azimuth fallback when an aircraft is directly overhead (zenith singularity). */
  private fallbackAz(tr: Track): number | undefined {
    return tr.ac.track ?? tr.history[tr.history.length - 1]?.track;
  }

  private toPoint(
    sample: GroundSample,
    cfg: Config,
    proj: ProjOpts,
    tr?: Track,
  ): Point {
    return projectAircraft(
      sample,
      cfg.projectionMode,
      proj,
      this.horizonM(cfg),
      tr ? this.fallbackAz(tr) : undefined,
    );
  }

  /** Call on any zoom/pan/pointer interaction — resets the idle clock so
   *  auto-drift waits again before taking over, and immediately hands
   *  control back to the real config values if a drift was in progress. */
  noteInteraction(): void {
    this.lastInteractionAt = performance.now();
    this.driftZoom = null;
  }

  /** Idle time before auto-drift engages, ms. */
  private static readonly DRIFT_IDLE_MS = 25_000;
  /** How long to hold on one satellite before picking a new target, ms. */
  private static readonly DRIFT_HOLD_MS = 14_000;
  /** Keep this many satellites in frame while drifting — enough that it
   *  reads as "watching a cluster pass overhead," not a single isolated dot
   *  (too tight) or back to the full, busy hemisphere (too loose). */
  private static readonly DRIFT_TARGET_SAT_COUNT = [5, 10] as const;
  /** Fallback zoom if satellite density can't fill the target count even at
   *  the sparsest reasonable framing (e.g. very few satellites above the
   *  horizon right now). */
  private static readonly DRIFT_ZOOM_FALLBACK = 8;

  /** Highest zoom (smallest field) that still keeps at least `minCount`
   *  satellites within the frame around (targetAz, targetAlt). Scans a fixed
   *  set of candidate zooms rather than solving analytically — cheap at a
   *  few thousand satellites, run only once per drift-target pick (every
   *  DRIFT_HOLD_MS), not per frame. */
  private pickDriftZoom(targetAz: number, targetAlt: number): number {
    const [minCount, maxCount] = Renderer.DRIFT_TARGET_SAT_COUNT;
    const candidateZooms = [3, 4, 6, 8, 10, 13, 16, 20, 25];
    let best = Renderer.DRIFT_ZOOM_FALLBACK;
    // Walk from tightest to widest; stop at the first (highest) zoom whose
    // field already contains at least minCount — that's the closest framing
    // that still satisfies "don't zoom in so far it's 1-2 satellites."
    for (let i = candidateZooms.length - 1; i >= 0; i--) {
      const zoom = candidateZooms[i];
      const fieldRadius = 90 / zoom;
      let count = 0;
      for (const s of this.sky.sats) {
        if (angularSeparationDeg(targetAz, targetAlt, s.az, s.alt) <= fieldRadius) {
          count++;
          if (count >= maxCount) break;
        }
      }
      if (count >= minCount) {
        best = zoom;
        break;
      }
      best = zoom; // sparsest satellites: fall back to the widest scanned
    }
    return best;
  }

  /**
   * While idle with satellites on, ease the effective view toward whichever
   * tracked satellite currently sits at a comfortable elevation (not
   * straight overhead, where apparent motion is fastest and least
   * watchable) — genuine screensaver behavior. Any interaction cancels it
   * instantly (see noteInteraction). Returns the (zoom, panAz, panAlt) to
   * actually render this frame.
   */
  private effectiveSkyView(cfg: Config, now: number): { zoom: number; panAz: number; panAlt: number } {
    const real = { zoom: cfg.skyZoom, panAz: cfg.skyPanAz, panAlt: cfg.skyPanAlt };
    if (cfg.projectionMode !== "sky" || !cfg.showSatellites) return real;
    const idleMs = now - this.lastInteractionAt;
    if (idleMs < Renderer.DRIFT_IDLE_MS) return real;

    // Only take over once the user's own view is already at the resting
    // (zoom=1) state — don't fight a manual zoom/pan left in place.
    if (cfg.skyZoom > 1.01) return real;

    if (this.driftZoom == null || now > this.driftHoldUntil) {
      // Pick a new target: prefer a satellite in a pleasant 25-65° elevation
      // band (visible, moving at a watchable rate, not near the horizon
      // haze or the fast-moving zenith point); fall back to the highest
      // available if none are in that band.
      const candidates = this.sky.sats;
      let target = candidates.find((s) => s.alt >= 25 && s.alt <= 65);
      if (!target && candidates.length) {
        target = candidates.reduce((a, b) => (b.alt > a.alt ? b : a));
      }
      if (target) {
        this.driftTargetAz = target.az;
        this.driftTargetAlt = target.alt;
        this.driftTargetZoom = this.pickDriftZoom(target.az, target.alt);
      }
      this.driftHoldUntil = now + Renderer.DRIFT_HOLD_MS;
      if (this.driftZoom == null) {
        this.driftZoom = 1;
        this.driftPanAz = cfg.skyPanAz;
        this.driftPanAlt = cfg.skyPanAlt;
      }
    }
    if (this.sky.sats.length) {
      const ease = 0.02;
      this.driftZoom += (this.driftTargetZoom - this.driftZoom) * ease;
      this.driftPanAz = lerpAzimuth(this.driftPanAz, this.driftTargetAz, ease);
      this.driftPanAlt += (this.driftTargetAlt - this.driftPanAlt) * ease;
      return { zoom: this.driftZoom, panAz: this.driftPanAz, panAlt: this.driftPanAlt };
    }
    return real;
  }

  /** Nearest hoverable within its hit radius (screen px, canvas-relative),
   *  or null. Called from pointermove on the canvas element. */
  hitTest(x: number, y: number): string | null {
    let best: HoverTarget | null = null;
    let bestDist = Infinity;
    for (const t of this.hoverTargets) {
      const d = Math.hypot(x - t.x, y - t.y);
      if (d <= t.r && d < bestDist) {
        best = t;
        bestDist = d;
      }
    }
    return best?.label ?? null;
  }

  private draw(): void {
    const cfg = this.getConfig();
    const ctx = this.ctx;
    const now = performance.now();
    const frameDt = this.prevFrame ? (now - this.prevFrame) / 1000 : 0.016;
    this.prevFrame = now;
    this.frameT = now / 1000;
    this.hoverTargets = [];

    if (this.canvas.clientWidth !== this.w || this.canvas.clientHeight !== this.h) {
      this.resize();
    }

    ctx.fillStyle = cfg.palette.bg;
    ctx.fillRect(0, 0, this.w, this.h);

    const pxPerM = pxPerMeter(this.w, this.h, cfg.radiusMiles);
    const proj: ProjOpts = {
      rotationDeg: cfg.rotationDeg,
      mirrorX: cfg.mirrorX,
      mirrorY: cfg.mirrorY,
      pxPerM,
      screenW: this.w,
      screenH: this.h,
    };

    this.updateSky(cfg, now);
    this.frameView = this.effectiveSkyView(cfg, now);
    this.drawSky(cfg, proj);
    this.drawOverlays(cfg, proj);
    if (cfg.showAirport) this.drawAirport(cfg, proj);

    const tt = now - RENDER_DELAY_MS;
    const visible: Visible[] = [];

    for (const [hex, tr] of this.tracks) {
      let stale = (now - tr.lastSeen) / 1000;
      if (this.sourceDownAt !== null) {
        // Outage: hold staleness at its value when the source went down, so
        // planes dim in place instead of vanishing. A hard cap still clears
        // the sky if the source stays dead — frozen planes stop being true.
        const downFor = (now - this.sourceDownAt) / 1000;
        stale = Math.max(0, stale - downFor);
        if ((now - tr.lastSeen) / 1000 > Math.max(cfg.staleSec, 90)) {
          this.tracks.delete(hex);
          continue;
        }
      }
      if (stale > cfg.staleSec) {
        this.tracks.delete(hex);
        continue;
      }
      // Trim history to the trail window (+ a little headroom for interp).
      const keep = Math.max(cfg.trailSeconds, 6) * 1000 + 4000;
      while (tr.history.length > 2 && now - tr.history[0].t > keep) tr.history.shift();

      // Fade in on spawn, fade out as it goes stale.
      const target = stale > cfg.staleSec * 0.5 ? 0 : 1;
      tr.life += (target - tr.life) * Math.min(1, frameDt * 3.5);

      if (!tr.hasPos) continue;
      const sample = this.sampleAt(tr, tt, cfg);
      if (!sample) continue;

      const rangeMi = metersToMiles(rangeMeters(sample.m));
      if (rangeMi > cfg.radiusMiles * 1.08) continue;

      const sky =
        cfg.projectionMode === "sky"
          ? groundToSkyAngles(sample.m, sample.altFt, this.fallbackAz(tr))
          : null;
      const p = this.toPoint(sample, cfg, proj, tr);
      // Ease the glyph toward its target heading (shortest arc) so once-a-fix
      // track changes read as a turn, not a snap (#61).
      const headingRaw = this.screenHeading(tr, tt, cfg, proj);
      const prevHeading = tr.headingSmooth ?? headingRaw;
      const arc = ((headingRaw - prevHeading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      const heading = prevHeading + arc * Math.min(1, frameDt * 6);
      tr.headingSmooth = heading;
      const edgeFade =
        cfg.projectionMode === "sky" && sky
          ? clamp01(sky.elev / 6) * clamp01((cfg.radiusMiles - rangeMi) / (cfg.radiusMiles * 0.14))
          : clamp01((cfg.radiusMiles - rangeMi) / (cfg.radiusMiles * 0.14));
      const alpha = clamp01(edgeFade) * tr.life * cfg.brightness;
      const alt = sample.altFt;
      const color = cfg.altitudeColor ? altRamp(alt) : hexToRgb(cfg.palette.glyph);
      const emergency = cfg.highlightEmergency && !!tr.ac.squawk && EMERGENCY_SQUAWKS.has(tr.ac.squawk);
      const sizeScale =
        cfg.projectionMode === "sky" && sky ? skyGlyphScale(sky.slantM) : 1;

      visible.push({ tr, sample, sky, p, heading, rangeMi, alpha, color, emergency, sizeScale });
      const acName = tr.ac.flight?.trim() || tr.ac.hex.toUpperCase();
      this.hoverTargets.push({
        x: p.x,
        y: p.y,
        r: Math.max(10, cfg.glyphSizePx * 0.6 * sizeScale),
        label: `${acName} · aircraft`,
      });
    }

    // Nearest last so it paints on top.
    visible.sort((a, b) => b.rangeMi - a.rangeMi);

    // Trails + glyphs for everyone.
    if (cfg.showDestArc) for (const v of visible) this.drawDestArc(cfg, proj, v);
    for (const v of visible) this.drawTrail(cfg, proj, v, tt);
    for (const v of visible) this.drawGlyph(cfg, v);

    // Labels: nearest are at the END after the sort.
    const byNear = [...visible].reverse(); // nearest first
    this.drawLabels(cfg, byNear);

    if (cfg.theme === "focus" && byNear.length) this.drawDetailPanel(cfg, byNear[0]);
  }

  /**
   * Run `draw` with the canvas rotated by `labelRotationDeg` around an anchor,
   * so text reads upright from where the viewer lies without moving the field.
   */
  private withLabelRotation(cfg: Config, ax: number, ay: number, draw: () => void): void {
    if (!cfg.labelRotationDeg) {
      draw();
      return;
    }
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate((cfg.labelRotationDeg * Math.PI) / 180);
    ctx.translate(-ax, -ay);
    draw();
    ctx.restore();
  }

  private screenHeading(tr: Track, tt: number, cfg: Config, proj: ProjOpts): number {
    // Reported ground track first: it's transponder-smoothed and stays stable
    // even when the aircraft barely moves on screen. Slow GA traffic at a wide
    // radius covers well under a pixel in this ±400 ms window, so a heading
    // derived from screen positions is atan2 of fix noise — the glyph spins
    // like a radar sweep (#61). Projecting a dead-reckoned point through the
    // same transform keeps rotation/mirror/sky-dome handling intact.
    const mid = this.sampleAt(tr, tt, cfg);
    const track = this.fallbackAz(tr);
    if (mid && track != null) {
      const ahead = deadReckon(mid.m, track, 120, 1);
      const p0 = this.toPoint(mid, cfg, proj, tr);
      const p1 = this.toPoint({ m: ahead, altFt: mid.altFt }, cfg, proj, tr);
      return Math.atan2(p1.y - p0.y, p1.x - p0.x);
    }
    // No reported track anywhere in history: fall back to screen motion, but
    // only over a baseline long enough that position jitter can't dominate.
    const a = this.sampleAt(tr, tt - 400, cfg);
    const b = this.sampleAt(tr, tt + 400, cfg);
    if (a && b) {
      const pa = this.toPoint(a, cfg, proj, tr);
      const pb = this.toPoint(b, cfg, proj, tr);
      if (Math.hypot(pb.x - pa.x, pb.y - pa.y) > 2) {
        return Math.atan2(pb.y - pa.y, pb.x - pa.x);
      }
    }
    return 0;
  }

  // --- overlays: whisper-quiet rings + compass ---
  private drawOverlays(cfg: Config, proj: ProjOpts): void {
    const ctx = this.ctx;
    const cx = this.w / 2;
    const cy = this.h / 2;
    const hM = this.horizonM(cfg);
    const skyMode = cfg.projectionMode === "sky";

    if (cfg.rangeRings) {
      ctx.save();
      if (skyMode) {
        // Elevation contours on the look-up dome (15° … 75° above horizon).
        for (const elev of [15, 30, 45, 60, 75]) {
          const r = (1 - elev / 90) * hM * proj.pxPerM;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.strokeStyle = rgba(hexToRgb(cfg.palette.grid), (0.22 + elev / 300) * cfg.brightness);
          ctx.lineWidth = 1;
          ctx.setLineDash(elev === 45 ? [] : [2, 8]);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.font = `300 9px ${cfg.fonts.mono}`;
        ctx.fillStyle = rgba(hexToRgb(cfg.palette.text), 0.22 * cfg.brightness);
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        for (const elev of [30, 60]) {
          const r = (1 - elev / 90) * hM * proj.pxPerM;
          ctx.fillText(`${elev}°`, cx + r + 4, cy);
        }
      } else {
        for (let step = 1; step <= Math.floor(convertDistance(cfg.radiusMiles, cfg.distanceUnit)); step++) {
          const r = step * (cfg.distanceUnit === "mi" ? MI_TO_M : KM_TO_M) * proj.pxPerM;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.strokeStyle = rgba(hexToRgb(cfg.palette.grid), 0.5 * cfg.brightness);
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 7]);
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }
      // Zenith mark.
      ctx.beginPath();
      ctx.arc(cx, cy, 2, 0, Math.PI * 2);
      ctx.fillStyle = rgba(hexToRgb(cfg.palette.grid), 0.7 * cfg.brightness);
      ctx.fill();
      ctx.restore();
    }

    if (cfg.compass) {
      ctx.save();
      ctx.font = `300 12px ${cfg.fonts.label}`;
      ctx.fillStyle = rgba(hexToRgb(cfg.palette.text), 0.32 * cfg.brightness);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      try {
        ctx.letterSpacing = "3px";
      } catch {
        /* older browsers */
      }
      for (const [label, deg] of [["N", 0], ["E", 90], ["S", 180], ["W", 270]] as [string, number][]) {
        const p = skyMode
          ? projectSkyPoint(deg, 1.5, proj, hM)
          : project(
              {
                east: Math.sin((deg * Math.PI) / 180) * 1e6,
                north: Math.cos((deg * Math.PI) / 180) * 1e6,
              },
              { ...proj, pxPerM: (Math.min(this.w, this.h) / 2) * 0.965 / 1e6 },
            );
        this.withLabelRotation(cfg, p.x, p.y, () => ctx.fillText(label, p.x, p.y));
      }
      try {
        ctx.letterSpacing = "0px";
      } catch {
        /* noop */
      }
      ctx.restore();
    }
  }

  // --- airport: runways at true geographic position ---
  private drawAirport(cfg: Config, proj: ProjOpts): void {
    const ctx = this.ctx;
    const rwyRgb: [number, number, number] = [150, 180, 220];
    {
      const ap = cfg.airport;
      let cx = 0;
      let cy = 0;
      let n = 0;
      for (const r of ap.runways) {
        const a = this.toScreen(r.le, cfg, proj);
        const b = this.toScreen(r.he, cfg, proj);
        // True runway width in px, nudged up a touch so it stays legible.
        const wpx = Math.max(2.5, r.widthFt * FT_TO_M * proj.pxPerM * 1.4);

        ctx.save();
        ctx.lineCap = "butt";
        // Asphalt body.
        ctx.strokeStyle = rgba(rwyRgb, 0.16 * cfg.brightness);
        ctx.lineWidth = wpx;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        // Dashed centerline.
        ctx.strokeStyle = rgba([210, 226, 255], 0.22 * cfg.brightness);
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 6]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.restore();

        cx += (a.x + b.x) / 2;
        cy += (a.y + b.y) / 2;
        n++;
      }
      // Airport label at the runway centroid.
      if (n) {
        cx /= n;
        cy /= n;
        ctx.save();
        ctx.font = `300 13px ${cfg.fonts.label}`;
        ctx.fillStyle = rgba(rwyRgb, 0.5 * cfg.brightness);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        try {
          ctx.letterSpacing = "4px";
        } catch {
          /* noop */
        }
        ctx.fillText(ap.name, cx, cy);
        try {
          ctx.letterSpacing = "0px";
        } catch {
          /* noop */
        }
        ctx.restore();
      }
    }
  }

  private toScreen(ll: [number, number], cfg: Config, proj: ProjOpts, altFt = 0): Point {
    const sample: GroundSample = {
      m: llToMeters(ll[0], ll[1], cfg.centerLat, cfg.centerLon),
      altFt,
    };
    return this.toPoint(sample, cfg, proj);
  }

  // --- sky layer (sun / moon / stars / satellites / meteors / comets) ---
  private updateSky(cfg: Config, now: number): void {
    const want =
      cfg.showStars ||
      cfg.showDeepStars ||
      cfg.showSun ||
      cfg.showMoon ||
      cfg.showSatellites ||
      cfg.showPlanets ||
      cfg.showMeteors ||
      cfg.showComets ||
      cfg.showMilkyWay;
    if (!want) {
      this.sky = {
        stars: [],
        deepStars: [],
        sats: [],
        planets: [],
        meteors: [],
        comets: [],
        milkyWay: [],
        activeShowers: [],
      };
      return;
    }
    // Meteors animate every frame (short-lived streaks); everything else is
    // cheap enough at ~3 Hz but not worth recomputing every frame.
    const skipStatic =
      now - this.skyComputedAt < 300 && this.skyOffsetUsed === cfg.skyTimeOffsetMin;
    if (skipStatic && !cfg.showMeteors) return;
    this.skyOffsetUsed = cfg.skyTimeOffsetMin;
    const date = new Date(Date.now() + cfg.skyTimeOffsetMin * 60000);
    const next = computeSky(date, cfg.centerLat, cfg.centerLon, {
      sun: cfg.showSun,
      moon: cfg.showMoon,
      stars: cfg.showStars,
      deepStars: cfg.showDeepStars,
      satellites: cfg.showSatellites,
      planets: cfg.showPlanets,
      meteors: cfg.showMeteors,
      showComets: cfg.showComets,
      milkyWay: cfg.showMilkyWay,
      magLimit: cfg.starMagLimit,
      deepStarMagLimit: cfg.deepStarMagLimit,
      cometMagLimit: cfg.cometMagLimit,
      tles: this.tles,
      comets: this.comets,
    });
    if (skipStatic) {
      // Only the meteor layer needed refreshing this tick.
      this.sky = { ...this.sky, meteors: next.meteors, activeShowers: next.activeShowers };
    } else {
      this.sky = next;
      this.skyComputedAt = now;
    }
  }

  /** Place an (azimuth, altitude) sky point on the field, honoring the
   *  current zoom/pan (this.frameView — either the real config values, or
   *  the idle auto-drift's animated view; see effectiveSkyView). Zoom=1 +
   *  pan centered on zenith = full-hemisphere view (unchanged legacy
   *  behavior). */
  private projectSky(az: number, alt: number, cfg: Config, proj: ProjOpts): Point {
    const v = this.frameView;
    return projectSkyPointZoomed(az, alt, v.panAz, v.panAlt, v.zoom, proj, this.horizonM(cfg));
  }

  /** Whether a sky point at (az, alt) currently falls within the visible
   *  zoomed/panned field (a bit past the edge, for labels whose anchor is
   *  offset outward from the object). */
  private inSkyView(az: number, alt: number, _cfg: Config): boolean {
    const v = this.frameView;
    if (v.zoom <= 1) return true;
    const sep = angularSeparationDeg(v.panAz, v.panAlt, az, alt);
    return sep <= 90 / v.zoom + 3;
  }

  private drawSky(cfg: Config, proj: ProjOpts): void {
    const ctx = this.ctx;
    const b = cfg.brightness;
    const skyLabels: SkyLabelEntry[] = [];

    // Milky Way band glow — drawn first (background), a faint diffuse arc
    // along the galactic plane. Everything else layers on top of it.
    if (cfg.showMilkyWay) this.drawMilkyWay(cfg, proj, b);

    // Dense unlabeled faint-star background field — drawn before the named
    // catalog so bright named stars still read as the visual focal points.
    if (cfg.showDeepStars && this.sky.deepStars.length) {
      for (const s of this.sky.deepStars) {
        const p = this.projectSky(s.az, s.alt, cfg, proj);
        const mag = s.mag ?? 5;
        const size = Math.max(0.4, 1.6 - mag * 0.22);
        const a = clamp01((7 - mag) / 7) * b * 0.55;
        if (a <= 0.02) continue;
        ctx.beginPath();
        ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(200,212,240,${a})`;
        ctx.fill();
      }
    }

    // Asterism lines (faint) — need star screen points by id.
    if (cfg.showStars && this.sky.stars.length) {
      const pts = new Map<string, Point>();
      for (const s of this.sky.stars) {
        if (s.id) pts.set(s.id, this.projectSky(s.az, s.alt, cfg, proj));
      }
      ctx.save();
      ctx.strokeStyle = `rgba(150,170,220,${0.14 * b})`;
      ctx.lineWidth = 1;
      for (const [a, c] of visibleAsterisms(cfg.constellations)) {
        const pa = pts.get(a);
        const pc = pts.get(c);
        if (pa && pc) {
          ctx.beginPath();
          ctx.moveTo(pa.x, pa.y);
          ctx.lineTo(pc.x, pc.y);
          ctx.stroke();
        }
      }
      ctx.restore();

      // Stars themselves, sized + twinkling by magnitude.
      for (const s of this.sky.stars) {
        const p = pts.get(s.id!)!;
        const mag = s.mag ?? 2;
        const size = starDrawSize(mag);
        const tw = 0.78 + 0.22 * Math.sin(this.frameT * 3 + s.az);
        const a = clamp01((2.8 - mag) / 3) * b * tw;
        ctx.beginPath();
        ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(214,224,255,${a})`;
        if (mag < 0.6) {
          ctx.shadowColor = `rgba(200,215,255,${a})`;
          ctx.shadowBlur = size * 3;
        }
        ctx.fill();
        ctx.shadowBlur = 0;
        if (mag < cfg.starLabelMagLimit && s.name) {
          skyLabels.push({
            p,
            name: s.name,
            color: "#AEB6C6",
            size,
            alpha: 0.5 * b,
            priority: mag,
          });
        }
        this.hoverTargets.push({
          x: p.x,
          y: p.y,
          r: Math.max(6, size + 4),
          label: `${s.name ? `${s.name} · star` : "star"}\nmag ${mag.toFixed(1)}`,
        });
      }
    }

    if (cfg.showMoon && this.sky.moon && this.sky.moon.alt > -2) {
      const p = this.projectSky(this.sky.moon.az, this.sky.moon.alt, cfg, proj);
      this.drawMoon(p, this.sky.moon.illum ?? 1, this.sky.moon.waning ?? false, b);
      this.hoverTargets.push({ x: p.x, y: p.y, r: 14, label: "Moon" });
    }
    if (cfg.showSun && this.sky.sun && this.sky.sun.alt > -2) {
      const p = this.projectSky(this.sky.sun.az, this.sky.sun.alt, cfg, proj);
      this.drawSun(p, b);
      this.hoverTargets.push({ x: p.x, y: p.y, r: 20, label: "Sun" });
    }
    if (cfg.showPlanets && this.sky.planets.length) {
      for (const pl of this.sky.planets) {
        const p = this.projectSky(pl.az, pl.alt, cfg, proj);
        const mag = pl.mag ?? 1;
        // Brighter planets (lower magnitude) read larger, with a soft glow.
        const size = planetDrawSize(mag);
        const col = PLANET_COLORS[pl.name ?? ""] ?? "230,224,205";
        ctx.beginPath();
        ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${col},${0.95 * b})`;
        if (mag < 0.5) {
          ctx.shadowColor = `rgba(${col},${b})`;
          ctx.shadowBlur = size * 2.5;
        }
        ctx.fill();
        ctx.shadowBlur = 0;
        if (pl.name) {
          skyLabels.push({
            p,
            name: pl.name,
            color: `rgb(${col})`,
            size,
            alpha: 0.7 * b,
            priority: mag,
          });
        }
        this.hoverTargets.push({
          x: p.x,
          y: p.y,
          r: Math.max(8, size + 5),
          label: `${pl.name} · planet\nmag ${mag.toFixed(1)}`,
        });
      }
    }

    if (cfg.showSatellites && this.sky.sats.length) {
      // Trail length is fixed in on-screen angular extent, not real seconds
      // of travel — otherwise the same TRAIL_SEC that looks right at zoom=1
      // stretches into a line spanning most of the frame once the idle-drift
      // zoom (up to 18x) magnifies that same angular length proportionally.
      const zoomNow = this.frameView.zoom;
      const trailDegOnScreen = 5; // constant apparent length, any zoom level
      // Zoomed-in objects (idle drift focuses on one satellite) read as a
      // real subject rather than a persistent pinprick when they're drawn
      // bigger — scale dot size (and glow) up with zoom, capped so it never
      // looks like a UI blob.
      const zoomSizeBoost = Math.min(3, Math.sqrt(zoomNow));

      for (const sat of this.sky.sats) {
        // At scale (thousands of satellites), skip drawing anything outside
        // the current zoom/pan field entirely rather than just its label.
        if (!this.inSkyView(sat.az, sat.alt, cfg)) continue;
        const p = this.projectSky(sat.az, sat.alt, cfg, proj);
        const iss = sat.kind === "iss";
        const size = (iss ? 3 : 1.6) * zoomSizeBoost;

        // Motion trail: a short fading line behind the satellite along its
        // real apparent travel direction (velAz/velAlt, computed once in
        // computeSky — no extra per-frame orbit math here). Reads as a
        // moving light rather than a static dot, without needing a history
        // buffer the way aircraft trails do.
        if (sat.velAz != null && sat.velAlt != null) {
          const speed = Math.hypot(sat.velAz, sat.velAlt);
          if (speed > 0.01) {
            // Clamp both ends: a floor so fast/zoomed objects still show a
            // visible sliver, and a ceiling so slow-appearing satellites
            // (near the horizon, where angular speed drops toward zero)
            // don't chase an unreachable apparent length into a trail
            // spanning real minutes of travel.
            const trailSec = Math.min(8, Math.max(0.5, trailDegOnScreen / (speed * Math.max(1, zoomNow))));
            const behindAz = sat.az - sat.velAz * trailSec;
            const behindAlt = sat.alt - sat.velAlt * trailSec;
            if (this.inSkyView(behindAz, behindAlt, cfg)) {
              const tail = this.projectSky(behindAz, behindAlt, cfg, proj);
              const grad = ctx.createLinearGradient(tail.x, tail.y, p.x, p.y);
              const trailCol = iss ? "140,255,214" : "180,205,255";
              grad.addColorStop(0, `rgba(${trailCol},0)`);
              grad.addColorStop(1, `rgba(${trailCol},${(iss ? 0.5 : 0.32) * b})`);
              ctx.save();
              ctx.strokeStyle = grad;
              ctx.lineWidth = iss ? 1.6 : 1;
              ctx.lineCap = "round";
              ctx.beginPath();
              ctx.moveTo(tail.x, tail.y);
              ctx.lineTo(p.x, p.y);
              ctx.stroke();
              ctx.restore();
            }
          }
        }

        ctx.beginPath();
        ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
        if (iss) {
          ctx.fillStyle = `rgba(140,255,214,${0.95 * b})`;
          ctx.shadowColor = `rgba(140,255,214,${b})`;
          ctx.shadowBlur = 10;
        } else {
          // Real satellites vary noticeably in brightness as their attitude
          // and solar panels catch the light — a slow per-object pulse
          // (phase-offset by az so they don't all pulse in lockstep) reads
          // as that same tumble/glint rather than a flat grid of dots. A
          // faint warm tint (vs. the cool star-blue) also helps them read as
          // a distinct population at a glance, not just more stars.
          const tw = 0.55 + 0.45 * Math.sin(this.frameT * 1.1 + sat.az * 3.7);
          ctx.fillStyle = `rgba(210,225,255,${0.55 * b * tw})`;
          if (tw > 0.75) {
            ctx.shadowColor = `rgba(210,225,255,${(tw - 0.75) * 2 * b})`;
            ctx.shadowBlur = size * 3;
          }
        }
        ctx.fill();
        ctx.shadowBlur = 0;
        if (iss) {
          skyLabels.push({
            p,
            name: "ISS",
            color: "#8CFFD6",
            size,
            alpha: 0.9 * b,
            priority: -1,
          });
        } else if (cfg.satelliteLabels && sat.name && this.satelliteLabelEligible(sat, cfg)) {
          skyLabels.push({
            p,
            name: sat.name,
            color: "#AEB6C6",
            size,
            alpha: 0.6 * b,
            priority: 5,
          });
        }
        this.hoverTargets.push({
          x: p.x,
          y: p.y,
          r: Math.max(6, size + 4),
          label: `${iss ? "ISS" : sat.name ? `${sat.name} · satellite` : "satellite"}\n${Math.round(sat.alt)}° elevation`,
        });
      }
    }

    if (cfg.showComets && this.sky.comets.length) {
      for (const comet of this.sky.comets) {
        const p = this.projectSky(comet.az, comet.alt, cfg, proj);
        const mag = comet.mag ?? 6;
        const size = Math.max(1.4, Math.min(3.5, 4 - mag * 0.35));
        ctx.beginPath();
        ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(180,235,220,${0.85 * b})`;
        ctx.shadowColor = `rgba(180,235,220,${0.7 * b})`;
        ctx.shadowBlur = size * 4; // soft coma glow
        ctx.fill();
        ctx.shadowBlur = 0;
        if (comet.name) {
          skyLabels.push({
            p,
            name: comet.name,
            color: "#B4EBDC",
            size,
            alpha: 0.85 * b,
            priority: -0.5,
          });
        }
        this.hoverTargets.push({
          x: p.x,
          y: p.y,
          r: Math.max(8, size + 5),
          label: comet.name ? `${comet.name} · comet` : "comet",
        });
      }
    }

    if (cfg.showMeteors && this.sky.meteors.length) {
      ctx.save();
      ctx.lineCap = "round";
      for (const m of this.sky.meteors) {
        const p1 = this.projectSky(m.az1, m.alt1, cfg, proj);
        const p2 = this.projectSky(m.az2, m.alt2, cfg, proj);
        const a = m.alpha * b;
        const grad = ctx.createLinearGradient(p1.x, p1.y, p2.x, p2.y);
        grad.addColorStop(0, `rgba(255,255,255,0)`);
        grad.addColorStop(1, `rgba(255,255,255,${0.9 * a})`);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.6;
        ctx.shadowColor = `rgba(255,255,255,${0.6 * a})`;
        ctx.shadowBlur = 4;
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      ctx.restore();
    }

    if (skyLabels.length) this.placeSkyLabels(skyLabels, cfg);
  }

  /** Milky Way band — a soft glow along the great circle of the galactic
   *  plane, drawn as a chain of overlapping radial gradients so it reads as
   *  diffuse light rather than individual points. Orientation uses the
   *  galactic-pole coordinates (J2000: RA 192.85°, Dec 27.13°) rotated into
   *  the local sky via the same sidereal-time math as the star field. */
  private drawMilkyWay(cfg: Config, proj: ProjOpts, b: number): void {
    const ctx = this.ctx;
    const opacity = cfg.milkyWayOpacity * b;
    if (opacity <= 0.01 || !this.sky.milkyWay.length) return;
    const pts: Point[] = [];
    for (const { az, alt } of this.sky.milkyWay) {
      if (alt < -15) continue;
      const a = Math.max(alt, -2);
      if (!inZoomedSkyField(az, a, this.frameView.panAz, this.frameView.panAlt, this.frameView.zoom)) continue;
      pts.push(this.projectSky(az, a, cfg, proj));
    }
    if (pts.length < 2) return;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, MILKY_WAY_BAND_PX);
      g.addColorStop(0, `rgba(180,190,215,${0.05 * opacity})`);
      g.addColorStop(1, "rgba(180,190,215,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, MILKY_WAY_BAND_PX, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Only label a non-ISS satellite when label density control allows it:
   *  0 = unlimited (fine at low satellite counts); otherwise only within
   *  satelliteLabelRadiusDeg of the current pan/zoom center, so a
   *  full ~10,000-object catalog doesn't draw thousands of overlapping names. */
  private satelliteLabelEligible(
    sat: { az: number; alt: number },
    cfg: Config,
  ): boolean {
    if (cfg.satelliteLabelRadiusDeg <= 0) return true;
    const sep = angularSeparationDeg(this.frameView.panAz, this.frameView.panAlt, sat.az, sat.alt);
    return sep <= cfg.satelliteLabelRadiusDeg;
  }

  private drawSun(p: Point, b: number): void {
    const ctx = this.ctx;
    ctx.save();
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 26);
    g.addColorStop(0, `rgba(255,210,120,${0.9 * b})`);
    g.addColorStop(0.4, `rgba(255,180,80,${0.4 * b})`);
    g.addColorStop(1, "rgba(255,170,70,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(255,224,150,${b})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawMoon(p: Point, illum: number, waning: boolean, b: number): void {
    const ctx = this.ctx;
    const r = 8;
    ctx.save();
    // Soft glow.
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 2.6);
    g.addColorStop(0, `rgba(220,228,245,${0.35 * b})`);
    g.addColorStop(1, "rgba(220,228,245,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 2.6, 0, Math.PI * 2);
    ctx.fill();
    // Dim full disc (earthshine).
    ctx.fillStyle = `rgba(64,72,90,${0.55 * b})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    // Lit region: bright limb semicircle + elliptical terminator.
    ctx.translate(p.x, p.y);
    ctx.scale(waning ? -1 : 1, 1); // bright limb on the right (waxing) / left (waning)
    const rx = r * (1 - 2 * illum); // >0 crescent, <0 gibbous, 0 = half
    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
    ctx.ellipse(0, 0, Math.abs(rx), r, 0, Math.PI / 2, -Math.PI / 2, rx > 0);
    ctx.closePath();
    ctx.fillStyle = `rgba(232,238,250,${b})`;
    ctx.fill();
    ctx.restore();
  }

  private skyLabel(
    p: Point,
    text: string,
    cfg: Config,
    alpha: number,
    color = "#AEB6C6",
    align: CanvasTextAlign = "left",
  ): void {
    const ctx = this.ctx;
    this.withLabelRotation(cfg, p.x, p.y, () => {
      ctx.save();
      ctx.font = `300 10px ${cfg.fonts.label}`;
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha;
      ctx.textAlign = align;
      ctx.textBaseline = "middle";
      try {
        ctx.letterSpacing = "1px";
      } catch {
        /* noop */
      }
      const tx = align === "right" ? p.x - 5 : align === "center" ? p.x : p.x + 5;
      ctx.fillText(text, tx, p.y);
      try {
        ctx.letterSpacing = "0px";
      } catch {
        /* noop */
      }
      ctx.restore();
    });
  }

  private measureSkyLabel(text: string, cfg: Config): { w: number; h: number } {
    const ctx = this.ctx;
    ctx.font = `300 10px ${cfg.fonts.label}`;
    try {
      ctx.letterSpacing = "1px";
    } catch {
      /* noop */
    }
    const w = ctx.measureText(text).width;
    try {
      ctx.letterSpacing = "0px";
    } catch {
      /* noop */
    }
    return { w: w + 2, h: 12 };
  }

  private skyLabelBox(
    anchor: Point,
    w: number,
    h: number,
    align: CanvasTextAlign,
  ): { x: number; y: number; w: number; h: number } {
    let x: number;
    if (align === "right") x = anchor.x - 5 - w;
    else if (align === "center") x = anchor.x - w / 2;
    else x = anchor.x + 5;
    return { x, y: anchor.y - h / 2, w, h };
  }

  /** Candidate label positions at a fixed gap from the object edge. */
  private skyLabelSlots(
    p: Point,
    size: number,
    h: number,
  ): { anchor: Point; align: CanvasTextAlign }[] {
    const g = SKY_LABEL_GAP;
    const r = size + g;
    const d = r * Math.SQRT1_2;
    const v = r + h / 2;
    const far = r + h + g;
    const farD = far * Math.SQRT1_2;

    return [
      { anchor: { x: p.x + d, y: p.y - d }, align: "left" },
      { anchor: { x: p.x + d, y: p.y + d }, align: "left" },
      { anchor: { x: p.x - d, y: p.y - d }, align: "right" },
      { anchor: { x: p.x - d, y: p.y + d }, align: "right" },
      { anchor: { x: p.x, y: p.y - v }, align: "center" },
      { anchor: { x: p.x, y: p.y + v }, align: "center" },
      { anchor: { x: p.x + farD, y: p.y - farD }, align: "left" },
      { anchor: { x: p.x - farD, y: p.y - farD }, align: "right" },
    ];
  }

  /** Place sky-object labels so they never overlap each other. */
  private placeSkyLabels(entries: SkyLabelEntry[], cfg: Config): void {
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const onScreen = (b: { x: number; y: number; w: number; h: number }) =>
      b.x >= 6 && b.x + b.w <= this.w - 6 && b.y >= 6 && b.y + b.h <= this.h - 6;

    const sorted = [...entries].sort((a, b) => a.priority - b.priority);

    for (const entry of sorted) {
      const { w, h } = this.measureSkyLabel(entry.name, cfg);
      type Slot = { anchor: Point; align: CanvasTextAlign };
      const slots: Slot[] = this.skyLabelSlots(entry.p, entry.size, h);

      let chosen: Slot | null = null;
      for (const slot of slots) {
        const box = this.skyLabelBox(slot.anchor, w, h, slot.align);
        if (onScreen(box) && !this.collides(box, placed)) {
          chosen = slot;
          placed.push(box);
          break;
        }
      }
      if (!chosen) {
        let slot = slots[0];
        let box = this.skyLabelBox(slot.anchor, w, h, slot.align);
        for (let k = 0; k < 10 && (this.collides(box, placed) || !onScreen(box)); k++) {
          slot = {
            anchor: { x: slot.anchor.x, y: slot.anchor.y - (h + SKY_LABEL_GAP) },
            align: slot.align,
          };
          box = this.skyLabelBox(slot.anchor, w, h, slot.align);
        }
        chosen = slot;
        placed.push(box);
      }
      this.skyLabel(chosen.anchor, entry.name, cfg, entry.alpha, entry.color, chosen.align);
    }
  }

  // --- window to elsewhere: faint arc toward destination ---
  private drawDestArc(cfg: Config, proj: ProjOpts, v: Visible): void {
    const ac = v.tr.ac;
    if (ac.lat == null || ac.lon == null || ac.destLat == null || ac.destLon == null) return;
    if (!routePlausible(ac, cfg)) return;

    const ctx = this.ctx;
    const destAz = bearing(ac.lat, ac.lon, ac.destLat, ac.destLon);
    const pts: Point[] = [v.p];

    if (cfg.projectionMode === "sky" && v.sky) {
      // Curve along the dome from the aircraft's sky position toward the
      // destination azimuth at the horizon — a realistic look-up great-circle hint.
      // When zoomed in, the curve legitimately runs off the edge of the
      // zoomed field well before reaching the true horizon — stop there
      // rather than let it project to a clamped/distorted position (that
      // reads as a stray line shooting across the whole canvas).
      const steps = 10;
      for (let i = 1; i <= steps; i++) {
        const f = i / steps;
        const az = lerpAzimuth(v.sky.az, destAz, f);
        const elev = v.sky.elev * (1 - f * f);
        if (!inZoomedSkyField(az, elev, this.frameView.panAz, this.frameView.panAlt, this.frameView.zoom)) break;
        pts.push(this.projectSky(az, elev, cfg, proj));
      }
    } else {
      const brg = destAz * DEG;
      const stepM = this.horizonM(cfg) * 0.5;
      const ahead = project(
        {
          east: v.sample.m.east + Math.sin(brg) * stepM,
          north: v.sample.m.north + Math.cos(brg) * stepM,
        },
        proj,
      );
      const dx = ahead.x - v.p.x;
      const dy = ahead.y - v.p.y;
      const len = Math.hypot(dx, dy) || 1;
      const L = Math.min(this.w, this.h) * 0.24;
      pts.push({ x: v.p.x + (dx / len) * L, y: v.p.y + (dy / len) * L });
    }

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = 1; i < pts.length; i++) {
      const f = i / (pts.length - 1);
      ctx.strokeStyle = rgba(v.color, (0.34 - f * 0.28) * v.alpha);
      ctx.lineWidth = 1.4 - f * 0.5;
      ctx.setLineDash(f > 0.6 ? [2, 5] : []);
      ctx.beginPath();
      ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
      ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // --- comet trail ---
  private drawTrail(cfg: Config, proj: ProjOpts, v: Visible, tt: number): void {
    if (cfg.trailSeconds <= 0) return;
    const ctx = this.ctx;
    const h = v.tr.history;
    if (h.length < 2) return;

    // Build the polyline from real fixes within the window, ending at the head.
    const windowMs = cfg.trailSeconds * 1000;
    const pts: { p: Point; age: number }[] = [];
    for (const s of h) {
      if (s.t < tt - windowMs || s.t > tt) continue;
      const sample: GroundSample = { m: s.m, altFt: s.altFt };
      pts.push({
        p: this.toPoint(sample, cfg, proj, v.tr),
        age: (tt - s.t) / windowMs,
      });
    }
    pts.push({ p: v.p, age: 0 });
    if (pts.length < 2) return;

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const f = 1 - b.age; // 1 at head, 0 at tail
      ctx.strokeStyle = rgba(v.color, 0.55 * f * v.alpha);
      ctx.lineWidth = 0.7 + 2.2 * f * (cfg.glyphSizePx / 14);
      ctx.beginPath();
      ctx.moveTo(a.p.x, a.p.y);
      ctx.lineTo(b.p.x, b.p.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // --- glyph: type-aware luminous silhouette ---
  private drawGlyph(cfg: Config, v: Visible): void {
    const ctx = this.ctx;
    const color = v.emergency ? hexToRgb(cfg.palette.warn) : v.color;
    const kind = classifyGlyph(v.tr.ac);
    const s = cfg.glyphSizePx * GLYPH_SCALE[kind] * v.sizeScale;

    ctx.save();
    ctx.translate(v.p.x, v.p.y);
    ctx.rotate(v.heading + Math.PI / 2);

    // Soft halo — restrained so the silhouette reads as an aircraft.
    const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 1.7);
    halo.addColorStop(0, rgba(color, 0.16 * v.alpha));
    halo.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, s * 1.7, 0, Math.PI * 2);
    ctx.fill();

    drawAircraftGlyph(ctx, kind, s, color, v.alpha, this.frameT, hexSeed(v.tr.ac.hex));
    ctx.restore();
  }

  // --- labels: restrained typography, nearest only ---
  private placedBoxes: { x: number; y: number; w: number; h: number }[] = [];

  private drawLabels(cfg: Config, nearestFirst: Visible[]): void {
    const limit =
      cfg.labelDensity === "all"
        ? nearestFirst.length
        : cfg.labelDensity === "nearestN"
          ? cfg.nearestN
          : 1;
    this.placedBoxes = [];
    for (let i = 0; i < Math.min(limit, nearestFirst.length); i++) {
      // Nearest labels brightest; gently dim further ones (but keep readable).
      const prom = 1 - i / Math.max(1, nearestFirst.length);
      this.drawLabel(cfg, nearestFirst[i], 0.7 + 0.3 * prom);
    }
  }

  private measureLabel(
    cfg: Config,
    lines: { text: string; kind: "title" | "sub" }[],
  ): { w: number; lh: number; h: number } {
    const ctx = this.ctx;
    const lh = 16;
    let w = 0;
    for (const ln of lines) {
      ctx.font = ln.kind === "title" ? `500 14px ${cfg.fonts.label}` : `400 11px ${cfg.fonts.label}`;
      try {
        ctx.letterSpacing = ln.kind === "title" ? "1.5px" : "0.5px";
      } catch {
        /* noop */
      }
      w = Math.max(w, ctx.measureText(ln.text).width);
    }
    try {
      ctx.letterSpacing = "0px";
    } catch {
      /* noop */
    }
    return { w: w + 2, lh, h: lines.length * lh };
  }

  private collides(
    b: { x: number; y: number; w: number; h: number },
    boxes: { x: number; y: number; w: number; h: number }[] = this.placedBoxes,
  ): boolean {
    const pad = 3;
    for (const p of boxes) {
      if (
        b.x - pad < p.x + p.w &&
        b.x + b.w + pad > p.x &&
        b.y - pad < p.y + p.h &&
        b.y + b.h + pad > p.y
      ) {
        return true;
      }
    }
    return false;
  }

  private drawLabel(cfg: Config, v: Visible, strength: number): void {
    const ctx = this.ctx;
    const lines = labelLines(cfg, v.tr.ac);
    if (!lines.length) return;
    const a = v.alpha * strength;
    if (a < 0.04) return;

    const { w, lh, h } = this.measureLabel(cfg, lines);

    const gap = cfg.glyphSizePx * 0.7 + 9;
    const onScreen = (b: { x: number; y: number; w: number; h: number }) =>
      b.x >= 6 && b.x + b.w <= this.w - 6 && b.y >= 6 && b.y + b.h <= this.h - 6;

    // Try four quadrants, then nudge downward, to avoid overlapping other labels.
    const candidates = [
      { x: v.p.x + gap, y: v.p.y - gap - h },
      { x: v.p.x + gap, y: v.p.y + gap },
      { x: v.p.x - gap - w, y: v.p.y - gap - h },
      { x: v.p.x - gap - w, y: v.p.y + gap },
    ];
    let box: { x: number; y: number; w: number; h: number } | null = null;
    for (const c of candidates) {
      const b = { x: c.x, y: c.y, w, h };
      if (onScreen(b) && !this.collides(b)) {
        box = b;
        break;
      }
    }
    if (!box) {
      let b = { x: v.p.x + gap, y: v.p.y - gap - h, w, h };
      for (let k = 0; k < 9 && (this.collides(b) || !onScreen(b)); k++) {
        b = { ...b, y: b.y + lh + 2 };
      }
      box = b;
    }
    box.x = Math.max(6, Math.min(box.x, this.w - 6 - w));
    box.y = Math.max(6, Math.min(box.y, this.h - 6 - h));
    this.placedBoxes.push(box);

    // Hairline leader from glyph to the nearest edge of the label.
    const anchorX = box.x + w / 2 < v.p.x ? box.x + w : box.x;
    const anchorY = Math.max(box.y, Math.min(v.p.y, box.y + h));
    // Rotate the whole label (leader + text) around the glyph so it reads
    // upright from where you lie, without disturbing the field.
    this.withLabelRotation(cfg, v.p.x, v.p.y, () => {
      ctx.save();
      ctx.strokeStyle = rgba(hexToRgb(cfg.palette.text), 0.24 * a);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(v.p.x, v.p.y);
      ctx.lineTo(anchorX, anchorY);
      ctx.stroke();

      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.shadowColor = "rgba(0,0,0,0.9)";
      ctx.shadowBlur = 6;
      ctx.strokeStyle = rgba(hexToRgb(cfg.palette.bg), a);
      ctx.lineWidth = 3;
      ctx.lineJoin = "round";

      let y = box.y;
      let lastLineKind;
      for (const ln of lines) {
        if (ln.kind === "title") {
          ctx.font = `500 14px ${cfg.fonts.label}`;
          ctx.fillStyle = rgba([245, 247, 255], a);
          try {
            ctx.letterSpacing = "1.5px";
          } catch {
            /* noop */
          }
        } else {
          ctx.font = `400 11px ${cfg.fonts.label}`;
          ctx.fillStyle = rgba(hexToRgb(cfg.palette.text), 0.82 * a);
          try {
            ctx.letterSpacing = "0.5px";
          } catch {
            /* noop */
          }
        }

        // after drawing the title we need a to draw further down for the following line (due to the larger font size of the title)
        y += lastLineKind === "title" ? lh + 2 : lh;

        ctx.strokeText(ln.text, box.x, y);
        ctx.fillText(ln.text, box.x, y);

        lastLineKind = ln.kind;
      }

      try {
        ctx.letterSpacing = "0px";
      } catch {
        /* noop */
      }
      ctx.restore();
    });
  }

  private drawDetailPanel(cfg: Config, v: Visible): void {
    const ac = v.tr.ac;
    const x = 40;
    const y = this.h - 120;
    this.withLabelRotation(cfg, x, y, () => this.drawDetailPanelText(cfg, v, ac, x, y));
  }

  private drawDetailPanelText(cfg: Config, v: Visible, ac: Aircraft, x: number, y: number): void {
    const ctx = this.ctx;
    ctx.save();

    ctx.shadowColor = "rgba(0,0,0,0.9)";
    ctx.shadowBlur = 10;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.strokeStyle = rgba(hexToRgb(cfg.palette.bg), v.alpha);
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    try {
      ctx.letterSpacing = "2px";
    } catch {
      /* noop */
    }

    const flightText = ac.flight ?? ac.hex.toUpperCase();
    ctx.font = `300 34px ${cfg.fonts.label}`;
    ctx.fillStyle = rgba([245, 247, 255], v.alpha);
    ctx.strokeText(flightText, x, y);
    ctx.fillText(flightText, x, y);
    try {
      ctx.letterSpacing = "0.5px";
    } catch {
      /* noop */
    }

    ctx.font = `400 15px ${cfg.fonts.label}`;
    ctx.fillStyle = rgba(hexToRgb(cfg.palette.text), 0.85 * v.alpha);
    const dpAlt = ac.altBaro ?? ac.altGeom;
    const bits = [
      ac.airline,
      ac.typeName ?? ac.typeCode,
      ac.onGround ? "on ground" : dpAlt != null ? formatAltitude(dpAlt, cfg.altitudeUnit) : null,
      ac.gs != null ? formatSpeed(ac.gs, cfg.speedUnit) : null,
      ac.origin && ac.destination && routePlausible(ac, cfg) ? `${ac.origin} → ${ac.destination}` : null,
    ].filter(Boolean);

    const detailText = bits.join("    ·    ");
    ctx.strokeText(detailText, x, y + 26);
    ctx.fillText(detailText, x, y + 26);
    try {
      ctx.letterSpacing = "0px";
    } catch {
      /* noop */
    }

    ctx.restore();
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Stable per-aircraft phase offset (0..2π) so props/rotors aren't all in sync. */
function hexSeed(hex: string): number {
  let n = 0;
  for (let i = 0; i < hex.length; i++) n = (n * 31 + hex.charCodeAt(i)) % 360;
  return (n / 360) * Math.PI * 2;
}

/** Civil local time at a place as HH:MM (real timezone incl. DST). Falls
 *  back to longitude-based mean solar time if the tz lookup fails — solar
 *  time can read ~an hour off the wall clock (#25). */
function localTimeAt(lat: number, lon: number): string {
  try {
    const tz = tzLookup(lat, lon);
    return new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: tz,
    });
  } catch {
    const now = new Date();
    const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    let m = (utcMin + (lon / 15) * 60) % 1440;
    if (m < 0) m += 1440;
    const hh = Math.floor(m / 60);
    const mm = Math.floor(m % 60);
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace("#", "");
  const n = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  const int = parseInt(n, 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}
