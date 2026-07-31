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

export function OrbitalView({ cfg, tles, aircraft, pullback, onHover }: OrbitalViewProps) {
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
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;
  // Observer marker's current screen-space position (px, container-relative),
  // updated every frame from its 3D position — the hit test compares the
  // pointer against this rather than doing a full raycast for one small dot.
  const markerScreenRef = useRef<{ x: number; y: number } | null>(null);

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
    const loop = () => {
      stateRef.current!.raf = requestAnimationFrame(loop);
      const c = cfgRef.current;

      // Earth's real sidereal rotation, applied to the mesh — satellite/
      // aircraft ECEF positions are Earth-fixed, so rotating the globe
      // under them (rather than transforming every point) keeps everything
      // in registration automatically.
      earthRotation = THREE.MathUtils.degToRad(gmstDegrees(new Date()));
      earth.rotation.y = earthRotation;
      stars.rotation.y = 0; // starfield stays fixed (inertial), Earth spins under it

      updatePoints(satPoints, orbitalSatellites(tlesRef.current, new Date()), earthRotation);
      updatePoints(
        acPoints,
        orbitalAircraft(aircraftRef.current).map((a) => ({ pos: a.pos })),
        earthRotation,
      );

      const obsEcef = geodeticToEcefKm(c.centerLat, c.centerLon, 0);
      const obsScene = ecefToScene(obsEcef, earthRotation);
      observerMarker.position.copy(obsScene);

      positionCamera(camera, obsScene, earthRadius, pullbackRef.current);

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
    const onPointerMove = (e: PointerEvent) => {
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
    const onPointerLeave = () => onHoverRef.current?.(null);
    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerleave", onPointerLeave);

    return () => {
      cancelAnimationFrame(stateRef.current!.raf);
      ro.disconnect();
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerleave", onPointerLeave);
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
 *  (pullback=1). One continuous move, not a cut. */
function positionCamera(
  camera: THREE.PerspectiveCamera,
  observerScene: THREE.Vector3,
  earthRadiusScene: number,
  pullback: number,
): void {
  const outward = observerScene.clone().normalize();
  const nearDist = earthRadiusScene * 1.001; // just above the surface
  const farDist = earthRadiusScene * 4.2; // whole Earth comfortably in frame
  const dist = THREE.MathUtils.lerp(nearDist, farDist, pullback);
  camera.position.copy(outward.clone().multiplyScalar(dist));
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
