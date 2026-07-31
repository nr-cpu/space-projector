// The "zoomed out past the sky dome" camera: a from-space view of the same
// Earth, satellites, and aircraft the ground-based dome shows, using the
// same TLE/aircraft data reduced to ECEF (shared/src/orbital.ts). WebGL/
// Three.js, not the 2D canvas renderer — real depth, a lit sphere, and a
// camera that can pull back and orbit, none of which Canvas 2D does well.

import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { Aircraft, Config } from "@shared/index.js";
import { EARTH_RADIUS_KM, orbitalAircraft, orbitalSatellites, geodeticToEcefKm } from "@shared/index.js";
import type { Tle } from "./celestial.js";

interface OrbitalViewProps {
  cfg: Config;
  tles: Tle[];
  aircraft: Aircraft[];
  /** 0 = fully at the ground-dome boundary (camera at the surface, looking
   *  up), 1 = fully pulled back to a whole-Earth view. Driven by zooming out
   *  past the dome's 1x floor; eases visually in the camera position, not a
   *  hard cut. */
  pullback: number;
  /** Fires as the pointer moves: screen-space coords + label when hovering
   *  the observer marker, null otherwise (mirrors the ground dome's hover
   *  tooltip contract in Display.tsx). */
  onHover?: (hover: { x: number; y: number; label: string } | null) => void;
  /** Requests a smooth return to the ground dome view (Shift+scroll-in or
   *  double-click while at whole-Earth zoom) — plain scroll-in is claimed by
   *  regional zoom instead, so heading back down needs an explicit signal;
   *  pullback itself is owned by Display.tsx, hence the callback rather than
   *  OrbitalView reducing it directly. */
  onRequestExitToGround?: () => void;
}

/** Scene-unit scale: 1 scene unit = 1000 km, so the whole Earth+satellite
 *  shell sits at human-friendly Three.js distances (Earth radius ~6.4,
 *  Starlink shell ~6.9-7.2) instead of raw km (which is numerically fine for
 *  floats but makes camera/light tuning awkward). */
const SCENE_SCALE = 1 / 1000;

interface SceneState {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  earth: THREE.Mesh;
  satPoints: THREE.Points;
  acPoints: THREE.Points;
  observerMarker: THREE.Mesh;
  raf: number;
}

export function OrbitalView({ cfg, tles, aircraft, pullback, onHover, onRequestExitToGround }: OrbitalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<SceneState | null>(null);

  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const tlesRef = useRef(tles);
  tlesRef.current = tles;
  const aircraftRef = useRef(aircraft);
  aircraftRef.current = aircraft;
  const pullbackRef = useRef(pullback);
  pullbackRef.current = pullback;
  const onRequestExitToGroundRef = useRef(onRequestExitToGround);
  onRequestExitToGroundRef.current = onRequestExitToGround;
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;
  // Observer marker's current screen-space position (px, container-relative),
  // updated every frame from its 3D position — the hit test compares the
  // pointer against this rather than doing a full raycast for one small dot.
  const markerScreenRef = useRef<{ x: number; y: number } | null>(null);

  // Manual camera orbit (drag-to-spin) — yaw/pitch offset in degrees applied
  // on top of the default observer-facing camera position. Dragging pauses
  // the automatic day/night spin (frozen at whatever angle it was, held
  // steady rather than fighting the user's drag) until pullback returns to 0
  // (scrolling back to the ground view resets both, so re-entering orbital
  // view later starts fresh at real time again rather than picking up a
  // stale manual orientation).
  const orbitYawRef = useRef(0);
  const orbitPitchRef = useRef(0);
  const draggingRef = useRef(false);
  const frozenSpinDegRef = useRef<number | null>(null);
  // Regional zoom: camera distance factor, 1 = whole-Earth framing (the
  // existing pullback=1 distance), down to REGION_ZOOM_MIN = tight enough to
  // frame roughly a continent. Only engages once already fully pulled back
  // (pullback=1) — scrolling further in at that point tightens the view
  // instead of doing nothing, scrolling back out returns to whole-Earth, and
  // beyond that hands back to pullback (which owns the orbital<->ground
  // boundary) exactly like the ground dome's own zoom floor hand-off.
  const regionZoomRef = useRef(1);

  // Scene setup — once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 500);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(renderer.domElement);

    // Sun-like directional light + faint ambient so the night side isn't
    // pure black (real Earth city lights would need a second emissive
    // texture — out of scope for the first cut).
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(5, 2, 3);
    scene.add(sun);
    scene.add(new THREE.AmbientLight(0x33384a, 1.1));

    const stars = makeStarfield();
    scene.add(stars);

    const earthRadius = EARTH_RADIUS_KM * SCENE_SCALE;
    const texLoader = new THREE.TextureLoader();
    // import.meta.env.BASE_URL (Vite's configured `base`, e.g. "/space-projector/"
    // on the GitHub Pages deploy) — a hardcoded absolute "/textures/..." path
    // resolves against the domain root instead and 404s under any subpath deploy.
    const earthTex = texLoader.load(`${import.meta.env.BASE_URL}textures/earth-day.jpg`);
    earthTex.colorSpace = THREE.SRGBColorSpace;
    const earth = new THREE.Mesh(
      new THREE.SphereGeometry(earthRadius, 64, 64),
      new THREE.MeshPhongMaterial({ map: earthTex, shininess: 4 }),
    );
    scene.add(earth);

    const satGeom = new THREE.BufferGeometry();
    const satMat = new THREE.PointsMaterial({
      color: 0xb4cdff,
      size: 0.035,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.85,
    });
    const satPoints = new THREE.Points(satGeom, satMat);
    scene.add(satPoints);

    const acGeom = new THREE.BufferGeometry();
    const acMat = new THREE.PointsMaterial({
      color: 0xffb066,
      size: 0.045,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.95,
    });
    const acPoints = new THREE.Points(acGeom, acMat);
    scene.add(acPoints);

    // A small marker at the viewer's own ground location, so the transition
    // from "standing here looking up" to "looking down at the globe" has a
    // visible anchor. Sized at 25% of the original — full-size read as an
    // oversized city-marker blob rather than a precise location pin.
    const observerMarker = new THREE.Mesh(
      new THREE.SphereGeometry(earthRadius * 0.0025, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0x8cffd6 }),
    );
    scene.add(observerMarker);

    stateRef.current = { renderer, scene, camera, earth, satPoints, acPoints, observerMarker, raf: 0 };

    const resize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    let earthRotation = 0;
    // Real sidereal rotation (~360°/day) is imperceptible over a viewing
    // session — the whole point of pulling back to the orbital view is to
    // *watch* the Earth turn from day to night with satellites floating
    // overhead, so once pulled back far enough this speeds the visual spin
    // up to something watchable while satellites/observer marker stay in
    // registration with it (they're positioned from this same angle — see
    // ecefToScene calls below). The sun stays fixed in the scene, so a
    // faster spin produces a correspondingly faster day/night terminator for
    // free, the same mechanism as the real thing. Near the ground-dome
    // boundary (pullback close to 0) this still tracks real GMST, so the
    // hard cut from the 2D dome doesn't visibly jump the globe's orientation.
    const VISUAL_DEG_PER_SEC = 3; // one full visible rotation every 2 minutes
    let visualRotationDeg = gmstDegrees(new Date());
    let lastVisualTick = performance.now();
    // Re-propagating thousands of TLEs via full SGP4 is expensive — at 60fps
    // that's ~10k satellite propagations/second, which is enough sustained
    // CPU + GC pressure (new arrays every frame) to visibly stall the tab
    // during a scroll gesture. Satellite motion is slow at visual timescales
    // (LEO satellites move a barely-perceptible amount over a few hundred ms),
    // so recomputing positions only a few times a second is indistinguishable
    // to the eye but cuts that cost by ~10-20x. The Earth's own rotation and
    // the camera move still update every frame, so the view stays smooth.
    const SAT_UPDATE_INTERVAL_MS = 300;
    let lastSatUpdate = 0;
    // Previous/next computed ECEF sets (pre-rotation) for satellites and
    // aircraft, interpolated every frame between recomputes so the fast
    // Earth spin (which keeps advancing every frame) doesn't produce a
    // visible ~1° snap each time SAT_UPDATE_INTERVAL_MS elapses — smooth
    // motion without paying for a full SGP4 propagation every frame.
    let satPrev: { pos: { x: number; y: number; z: number } }[] = [];
    let satNext: { pos: { x: number; y: number; z: number } }[] = [];
    let acPrev: { pos: { x: number; y: number; z: number } }[] = [];
    let acNext: { pos: { x: number; y: number; z: number } }[] = [];
    const loop = () => {
      stateRef.current!.raf = requestAnimationFrame(loop);
      const c = cfgRef.current;
      const now = performance.now();

      // Scrolled all the way back to the ground view: clear the manual drag
      // orbit, regional zoom, and any frozen spin angle, so re-entering
      // orbital view later starts fresh (real-time spin, whole-Earth
      // framing) rather than picking up a stale manual orientation.
      if (pullbackRef.current <= 0) {
        orbitYawRef.current = 0;
        orbitPitchRef.current = 0;
        regionZoomRef.current = 1;
        frozenSpinDegRef.current = null;
      }

      // Advance the sped-up visual angle at a constant rate regardless of
      // pullback (so it's already caught up and spinning smoothly the
      // instant pullback crosses into "watch it turn" territory, rather than
      // restarting from a standstill) — but not while the user is actively
      // dragging the globe, which pauses the spin at its current angle so
      // the drag isn't fighting an angle that keeps advancing underneath it.
      const dtSec = (now - lastVisualTick) / 1000;
      lastVisualTick = now;
      if (!draggingRef.current) {
        visualRotationDeg = (visualRotationDeg + VISUAL_DEG_PER_SEC * dtSec) % 360;
      }

      // Blend real GMST (accurate registration right at the dome boundary)
      // toward the fast visual spin as pullback increases, so the globe's
      // orientation doesn't jump the instant the hard cut happens.
      const realDeg = gmstDegrees(new Date());
      const blend = THREE.MathUtils.smoothstep(pullbackRef.current, 0.15, 0.5);
      let shownDeg: number;
      if (draggingRef.current) {
        if (frozenSpinDegRef.current == null) {
          frozenSpinDegRef.current = THREE.MathUtils.lerp(realDeg, visualRotationDeg, blend);
        }
        shownDeg = frozenSpinDegRef.current;
      } else {
        frozenSpinDegRef.current = null;
        shownDeg = THREE.MathUtils.lerp(realDeg, visualRotationDeg, blend);
      }

      // Earth's rotation, applied to the mesh — satellite/aircraft ECEF
      // positions are Earth-fixed, so rotating the globe under them (rather
      // than transforming every point) keeps everything in registration
      // automatically, whichever rotation rate is in effect.
      earthRotation = THREE.MathUtils.degToRad(shownDeg);
      earth.rotation.y = earthRotation;
      stars.rotation.y = 0; // starfield stays fixed (inertial), Earth spins under it

      if (now - lastSatUpdate >= SAT_UPDATE_INTERVAL_MS || (satPrev.length === 0 && satNext.length === 0)) {
        lastSatUpdate = now;
        satPrev = satNext;
        satNext = orbitalSatellites(tlesRef.current, new Date());
        acPrev = acNext;
        acNext = orbitalAircraft(aircraftRef.current).map((a) => ({ pos: a.pos }));
      }
      // Interpolate rotation-agnostic ECEF positions between the last two
      // computed sets, then apply the current (per-frame) earthRotation —
      // this is what actually removes the jitter, since it keeps the
      // rendered positions moving smoothly in step with the globe's
      // continuous spin instead of holding still for 300ms and snapping.
      const satInterpT = SAT_UPDATE_INTERVAL_MS > 0 ? Math.min(1, (now - lastSatUpdate) / SAT_UPDATE_INTERVAL_MS) : 1;
      updatePoints(satPoints, interpolatePositions(satPrev, satNext, satInterpT), earthRotation);
      updatePoints(acPoints, interpolatePositions(acPrev, acNext, satInterpT), earthRotation);

      const obsEcef = geodeticToEcefKm(c.centerLat, c.centerLon, 0);
      // Marker/satellites/aircraft ride the fast visual spin (earthRotation)
      // so they visibly move with the turning globe, but the CAMERA'S
      // viewing direction must come from the real, slow rotation instead —
      // otherwise the camera itself orbits the globe once per fast-spin
      // revolution (every ~2 minutes) rather than sitting still while the
      // globe turns beneath it. That coupling was the actual cause of both
      // "stars sweeping past instead of the Earth turning" (the camera's own
      // motion around the origin drags the fixed starfield across the frame)
      // and "satellites jiggling" (camera re-orbits every frame, satellite
      // positions only refresh every SAT_UPDATE_INTERVAL_MS, so they visibly
      // lag behind the camera's continuous motion between refreshes).
      const cameraRotation = THREE.MathUtils.degToRad(realDeg);
      const obsSceneCamera = ecefToScene(obsEcef, cameraRotation);
      const obsScene = ecefToScene(obsEcef, earthRotation);
      observerMarker.position.copy(obsScene);

      positionCamera(
        camera,
        obsSceneCamera,
        earthRadius,
        pullbackRef.current,
        orbitYawRef.current,
        orbitPitchRef.current,
        regionZoomRef.current,
      );

      // Project the marker to screen space for hover hit-testing. Also check
      // it's actually facing the camera (not on the globe's far side) —
      // otherwise the marker would be "hoverable" straight through the Earth.
      const toMarker = obsScene.clone().normalize();
      const toCamera = camera.position.clone().normalize();
      const facingCamera = toMarker.dot(toCamera) > 0.1;
      if (facingCamera) {
        const proj = obsScene.clone().project(camera);
        const w = container.clientWidth;
        const h = container.clientHeight;
        markerScreenRef.current = {
          x: ((proj.x + 1) / 2) * w,
          y: ((1 - proj.y) / 2) * h,
        };
      } else {
        markerScreenRef.current = null;
      }

      renderer.render(scene, camera);
    };
    loop();

    const HOVER_RADIUS_PX = 14;
    let lastDragX = 0;
    let lastDragY = 0;
    const DEG_PER_PX = 0.25;

    const onPointerMove = (e: PointerEvent) => {
      if (draggingRef.current) {
        const dx = e.clientX - lastDragX;
        const dy = e.clientY - lastDragY;
        lastDragX = e.clientX;
        lastDragY = e.clientY;
        orbitYawRef.current = (orbitYawRef.current - dx * DEG_PER_PX) % 360;
        orbitPitchRef.current = THREE.MathUtils.clamp(orbitPitchRef.current - dy * DEG_PER_PX, -80, 80);
        onHoverRef.current?.(null); // no stale tooltip while actively dragging
        return;
      }

      const m = markerScreenRef.current;
      const rect = container.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      if (m && Math.hypot(px - m.x, py - m.y) <= HOVER_RADIUS_PX) {
        const ap = cfgRef.current.airport;
        const label = ap ? `${ap.icao}\n${ap.fullName ?? ap.name}` : "Observer";
        onHoverRef.current?.({ x: m.x, y: m.y, label });
      } else {
        onHoverRef.current?.(null);
      }
    };
    const onPointerLeave = () => {
      if (!draggingRef.current) onHoverRef.current?.(null);
    };
    // Only meaningful once fully pulled back (matches positionCamera's own
    // manualStrength ramp) — dragging mid-transition would fight the
    // ground-dome hand-off framing.
    const onPointerDown = (e: PointerEvent) => {
      if (pullbackRef.current < 0.9) return;
      draggingRef.current = true;
      lastDragX = e.clientX;
      lastDragY = e.clientY;
      container.setPointerCapture(e.pointerId);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      try {
        container.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    };

    // Regional zoom: only engages once fully pulled back and not mid-drag.
    // Plain scroll claims the whole in/out range for regional zoom (standard
    // "scroll to zoom" convention) — 1 = whole Earth down to REGION_ZOOM_MIN
    // = roughly a continent, and it's the only thing plain scroll does here,
    // never handing off to pullback on its own. Returning to the ground dome
    // from whole-Earth is a deliberate separate gesture (Shift+scroll-in, or
    // double-click) specifically because plain scroll-in is already spoken
    // for by regional zoom and the two can't share it unambiguously.
    const REGION_ZOOM_STEP = 0.0012;
    const onWheel = (e: WheelEvent) => {
      if (pullbackRef.current < 0.99) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey && e.deltaY < 0 && regionZoomRef.current >= 0.999) {
        onRequestExitToGroundRef.current?.();
        return;
      }
      const factor = Math.exp(e.deltaY * REGION_ZOOM_STEP);
      regionZoomRef.current = THREE.MathUtils.clamp(regionZoomRef.current * factor, REGION_ZOOM_MIN, 1);
    };
    const onDoubleClick = () => {
      if (pullbackRef.current < 0.99) return;
      if (regionZoomRef.current < 0.999) {
        // First double-click zooms back out to whole-Earth (undo regional
        // zoom); only a second one, once already at whole-Earth, exits.
        regionZoomRef.current = 1;
        return;
      }
      onRequestExitToGroundRef.current?.();
    };

    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerleave", onPointerLeave);
    container.addEventListener("pointerdown", onPointerDown);
    container.addEventListener("pointerup", onPointerUp);
    container.addEventListener("dblclick", onDoubleClick);
    container.addEventListener("pointercancel", onPointerUp);
    container.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      cancelAnimationFrame(stateRef.current!.raf);
      ro.disconnect();
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerleave", onPointerLeave);
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointerup", onPointerUp);
      container.removeEventListener("dblclick", onDoubleClick);
      container.removeEventListener("pointercancel", onPointerUp);
      container.removeEventListener("wheel", onWheel);
      renderer.dispose();
      satGeom.dispose();
      acGeom.dispose();
      earthTex.dispose();
      container.removeChild(renderer.domElement);
      stateRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className="orbital-view" />;
}

/** GMST (Greenwich Mean Sidereal Time), degrees — how far Earth has spun
 *  relative to the fixed stars. Standard low-precision formula, plenty
 *  accurate for a visual globe (not a targeting computation). */
function gmstDegrees(date: Date): number {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const T = (jd - 2451545.0) / 36525;
  let gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * T * T;
  gmst = gmst % 360;
  return gmst < 0 ? gmst + 360 : gmst;
}

/** Lerps ECEF positions between two computed sets (previous/next SGP4
 *  propagation) by array index. Satellite order is stable frame-to-frame
 *  (same TLE list, same iteration order), so index-matching is safe there;
 *  aircraft can appear/disappear between updates, so a length mismatch just
 *  falls back to the newer set for the tail rather than interpolating
 *  mismatched entries. */
function interpolatePositions(
  prev: { pos: { x: number; y: number; z: number } }[],
  next: { pos: { x: number; y: number; z: number } }[],
  t: number,
): { pos: { x: number; y: number; z: number } }[] {
  if (prev.length !== next.length) return next;
  const out = new Array<{ pos: { x: number; y: number; z: number } }>(next.length);
  for (let i = 0; i < next.length; i++) {
    const a = prev[i].pos;
    const b = next[i].pos;
    out[i] = {
      pos: {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
      },
    };
  }
  return out;
}

/** ECEF (km) -> Three.js scene position, accounting for the Earth mesh's own
 *  Y-axis rotation (so points painted in the Earth-fixed frame land in the
 *  right place on the rotating globe) and the ECEF->Three.js axis swap
 *  (ECEF Z = spin axis -> Three.js Y = up). */
function ecefToScene(ecef: { x: number; y: number; z: number }, earthRotationRad: number): THREE.Vector3 {
  const v = new THREE.Vector3(ecef.x, ecef.z, -ecef.y).multiplyScalar(SCENE_SCALE);
  v.applyAxisAngle(new THREE.Vector3(0, 1, 0), earthRotationRad);
  return v;
}

function updatePoints(
  points: THREE.Points,
  items: { pos: { x: number; y: number; z: number } }[],
  earthRotationRad: number,
): void {
  const positions = new Float32Array(items.length * 3);
  for (let i = 0; i < items.length; i++) {
    const v = ecefToScene(items[i].pos, earthRotationRad);
    positions[i * 3] = v.x;
    positions[i * 3 + 1] = v.y;
    positions[i * 3 + 2] = v.z;
  }
  points.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  points.geometry.computeBoundingSphere();
}

/** Camera eases from "at the observer's surface point, looking outward"
 *  (pullback=0, matches where the ground dome view leaves off) to "pulled
 *  back along that same radial line, looking at the whole Earth"
 *  (pullback=1). One continuous move, not a cut.
 *
 *  Once fully pulled back, orbitYaw/orbitPitch (degrees, drag-to-rotate) spin
 *  the camera around the globe's center instead of sitting fixed above the
 *  observer, and regionZoom (1 = whole Earth, down to REGION_ZOOM_MIN =
 *  roughly a continent) tightens the distance — both ramped in by pullback
 *  itself so they don't fight the ground-dome hand-off while still
 *  transitioning. */
const REGION_ZOOM_MIN = 0.22;
function positionCamera(
  camera: THREE.PerspectiveCamera,
  observerScene: THREE.Vector3,
  earthRadiusScene: number,
  pullback: number,
  orbitYawDeg: number,
  orbitPitchDeg: number,
  regionZoom: number,
): void {
  const outward = observerScene.clone().normalize();
  const nearDist = earthRadiusScene * 1.001; // just above the surface
  const farDist = earthRadiusScene * 4.2; // whole Earth comfortably in frame
  // Regional-zoom floor: framed to comfortably show roughly a continent, not
  // a naive fraction of farDist — that would put the camera inside the globe
  // (REGION_ZOOM_MIN * farDist < earthRadiusScene) at the tightest setting.
  const regionDist = earthRadiusScene * 1.5;
  const pulledBackDist = THREE.MathUtils.lerp(nearDist, farDist, pullback);
  const dist = THREE.MathUtils.lerp(
    regionDist,
    pulledBackDist,
    THREE.MathUtils.clamp((regionZoom - REGION_ZOOM_MIN) / (1 - REGION_ZOOM_MIN), 0, 1),
  );

  // Ramp the manual orbit in smoothly over the same range the day/night spin
  // uses, so drag/regional-zoom only takes hold once meaningfully pulled
  // back, not mid-transition from the ground dome.
  const manualStrength = THREE.MathUtils.smoothstep(pullback, 0.15, 0.5);
  let dir = outward;
  if (manualStrength > 0.001) {
    const worldUp = new THREE.Vector3(0, 1, 0);
    const yawed = outward.clone().applyAxisAngle(worldUp, THREE.MathUtils.degToRad(orbitYawDeg * manualStrength));
    // Pitch axis derived from the yawed direction itself (cross with world
    // up), not a fixed world axis — otherwise the tilt only reads as a clean
    // up/down drag for observers near a particular longitude and goes
    // diagonal everywhere else.
    const pitchAxis = new THREE.Vector3().crossVectors(worldUp, yawed).normalize();
    dir = yawed.applyAxisAngle(pitchAxis, THREE.MathUtils.degToRad(orbitPitchDeg * manualStrength));
  }

  camera.position.copy(dir.multiplyScalar(dist));
  camera.up.set(0, 1, 0);
  camera.lookAt(pullback < 0.05 ? outward.clone().multiplyScalar(nearDist * 1.5) : new THREE.Vector3(0, 0, 0));
}

function makeStarfield(): THREE.Points {
  const COUNT = 3000;
  const positions = new Float32Array(COUNT * 3);
  for (let i = 0; i < COUNT; i++) {
    // Uniform points on a large sphere (fixed, "inertial" backdrop).
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const r = 200;
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.5, sizeAttenuation: false });
  return new THREE.Points(geom, mat);
}
