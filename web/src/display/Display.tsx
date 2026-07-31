import { useEffect, useRef, useState } from "react";
import type { Config, Theme } from "@shared/index.js";
import { DEFAULT_CONFIG, formatDistance } from "@shared/index.js";
import { useStream } from "../lib/useStream.js";
import { useAmbientMode, kioskRequested } from "../lib/useAmbientMode.js";
import { Renderer } from "./renderer.js";
import { QuickSettings } from "./QuickSettings.js";
import { OrbitalView } from "./OrbitalView.js";
import type { Tle } from "./celestial.js";

const THEMES: Theme[] = ["ambient", "telemetry", "focus"];

export function Display() {
  const { state, conn } = useStream("display");
  const ambient = useAmbientMode();
  const isKiosk = kioskRequested();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Wheel (zoom/pan) listens here, not on the ground canvas — the canvas gets
  // pointer-events:none the instant the orbital view takes over (see the
  // render below), which makes it untargetable by the browser's event hit-
  // testing regardless of what's registered on it via addEventListener. Since
  // scrolling has to keep working continuously across the ground<->orbital
  // boundary (one gesture, not two disconnected controls — see applyZoomDelta),
  // the listener needs a home that's always hit-testable no matter which view
  // is showing.
  const rootRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; label: string } | null>(null);
  // 0 = ground dome view (unchanged); 1 = fully pulled back to orbital view.
  // Local-only — each viewer's own camera exploration, not synced to the
  // shared config the way skyZoom/skyPanAz/skyPanAlt are.
  const [pullback, setPullback] = useState(0);
  const pullbackRef = useRef(0);
  // Which view is actually showing right now (hard tipping point, with
  // hysteresis — see the render below). Read by the ground-canvas pointer
  // handlers so hover hit-testing/tooltips stop firing the instant the
  // orbital view takes over, even though the canvas element (and its
  // listeners) stay mounted underneath.
  const orbitalActiveRef = useRef(false);
  // Latches true the first time pullback ever leaves 0, so OrbitalView mounts
  // (and starts its WebGL setup + texture fetch) as soon as the user starts
  // scrolling out, well before the hard cutoff needs it visible — never unmounts
  // again after that, so re-crossing the boundary later is instant.
  const everEnteredOrbitalRef = useRef(false);
  const [tles, setTles] = useState<Tle[]>([]);

  // Keep the latest config in a ref so the RAF loop always reads fresh values.
  const configRef = useRef<Config>(state.config ?? DEFAULT_CONFIG);
  configRef.current = state.config ?? DEFAULT_CONFIG;

  // Latest ambient toggle in a ref so the keydown listener stays subscribed once.
  const ambientToggleRef = useRef(ambient.toggle);
  ambientToggleRef.current = ambient.toggle;

  // Create renderer once.
  useEffect(() => {
    if (!canvasRef.current) return;
    const r = new Renderer(canvasRef.current, () => configRef.current);
    rendererRef.current = r;
    r.start();
    const onResize = () => r.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      r.stop();
      rendererRef.current = null;
    };
  }, []);

  // Feed snapshots.
  useEffect(() => {
    rendererRef.current?.update(state.aircraft);
  }, [state.now, state.aircraft]);

  // Mirror the Renderer's already-fetched TLE set into React state, but only
  // while the orbital pullback view is actually visible — no point paying
  // for the extra re-renders while the ground dome is showing.
  useEffect(() => {
    if (pullback <= 0) return;
    const id = setInterval(() => {
      const t = rendererRef.current?.getTles();
      if (t) setTles(t);
    }, 2000);
    return () => clearInterval(id);
  }, [pullback]);

  // Source health: during an outage the renderer holds planes instead of
  // staling them out. A dropped WebSocket counts as an outage too.
  useEffect(() => {
    rendererRef.current?.setSourceOk(state.connected && (state.status?.ok ?? true));
  }, [state.connected, state.status]);

  // Keyboard calibration (handy when a keyboard is plugged into the Pi).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const c = configRef.current;
      switch (e.key) {
        case "r":
          conn.patchConfig({ rotationDeg: (c.rotationDeg + 5) % 360 });
          break;
        case "R":
          conn.patchConfig({ rotationDeg: (c.rotationDeg - 5 + 360) % 360 });
          break;
        case "m":
          conn.patchConfig({ mirrorX: !c.mirrorX });
          break;
        case "M":
          conn.patchConfig({ mirrorY: !c.mirrorY });
          break;
        case "t": {
          const next = THEMES[(THEMES.indexOf(c.theme) + 1) % THEMES.length];
          conn.patchConfig({ theme: next });
          break;
        }
        case "[":
          conn.patchConfig({ radiusMiles: Math.max(0.5, c.radiusMiles - 0.5) });
          break;
        case "]":
          conn.patchConfig({ radiusMiles: c.radiusMiles + 0.5 });
          break;
        case "h":
          conn.patchConfig({ showHud: !c.showHud });
          break;
        case "f":
          ambientToggleRef.current();
          break;
        case "0":
          // Reset sky zoom/pan to the full-hemisphere default view.
          rendererRef.current?.noteInteraction();
          conn.patchConfig({ skyZoom: 1, skyPanAz: 0, skyPanAlt: 90 });
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [conn]);

  // Sky zoom (scroll wheel / trackpad pinch) + pan (click-drag, OR a two-
  // finger trackpad swipe), for exploring the satellite field. Only
  // meaningful in "sky" projection mode; a no-op otherwise since "map" mode
  // has no az/alt dome to zoom into.
  //
  // Browsers report trackpad pinch-to-zoom as a wheel event with
  // ctrlKey=true (synthetic — no actual Ctrl key involved); a two-finger
  // swipe is a plain wheel event with real deltaX/deltaY and ctrlKey=false.
  // That's the only reliable signal to tell the two gestures apart from a
  // wheel event alone (there's no separate "pan" gesture type on the web).
  useEffect(() => {
    const canvas = canvasRef.current;
    const root = rootRef.current;
    if (!canvas || !root) return;

    // Marks OrbitalView for mounting (see the render below) the first time
    // pullback goes positive, and updates both the ref (read by the RAF-driven
    // camera math) and the state (drives the React re-render).
    const updatePullback = (next: number) => {
      pullbackRef.current = next;
      if (next > 0) everEnteredOrbitalRef.current = true;
      setPullback(next);
    };

    const applyZoomDelta = (dy: number) => {
      const c = configRef.current;
      // Already pulled back into orbital view: scrolling further out eases
      // pullback toward 1 (whole Earth); scrolling in eases it back toward
      // 0, and once it reaches 0 control returns to the normal sky zoom —
      // one continuous gesture across the boundary, not two disconnected
      // controls.
      if (pullbackRef.current > 0) {
        const next = Math.max(0, Math.min(1, pullbackRef.current + dy * 0.0009));
        updatePullback(next);
        if (next > 0) return;
      }

      const factor = Math.exp(-dy * 0.0015);
      const nextZoom = c.skyZoom * factor;
      if (nextZoom < 1 && dy > 0) {
        // Crossed the dome's zoom floor while still scrolling out: hand off
        // to the orbital pullback instead of clamping at 1x forever.
        conn.patchConfig({ skyZoom: 1 });
        const next = Math.min(1, (1 - nextZoom) * 1.5);
        updatePullback(next);
        return;
      }
      conn.patchConfig({ skyZoom: Math.max(1, Math.min(40, nextZoom)) });
    };

    const applyPanDelta = (dx: number, dy: number) => {
      const c = configRef.current;
      if (c.skyZoom <= 1) return; // nothing to pan around at the resting view
      const degPerPx = 0.15 / c.skyZoom;
      const nextAz = ((c.skyPanAz + dx * degPerPx) % 360 + 360) % 360;
      const nextAlt = Math.max(-10, Math.min(90, c.skyPanAlt + dy * degPerPx));
      conn.patchConfig({ skyPanAz: nextAz, skyPanAlt: nextAlt });
    };

    const onWheel = (e: WheelEvent) => {
      const c = configRef.current;
      if (c.projectionMode !== "sky") return;
      e.preventDefault();
      rendererRef.current?.noteInteraction();

      // Vertical scroll/swipe zooms (the universal map-app convention) —
      // except Shift+scroll, which pans vertically instead, since a plain
      // vertical two-finger trackpad swipe and a mouse wheel produce near-
      // identical events and can't both mean "zoom" and "pan" at once.
      // A real horizontal swipe component (no modifier needed) pans
      // horizontally either way.
      if (e.shiftKey) {
        applyPanDelta(0, e.deltaY || e.deltaX);
        return;
      }
      if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY) * 0.6) {
        applyPanDelta(e.deltaX, 0);
        return;
      }
      applyZoomDelta(e.deltaY);
    };

    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const onPointerDown = (e: PointerEvent) => {
      const c = configRef.current;
      if (c.projectionMode !== "sky" || c.skyZoom <= 1) return;
      rendererRef.current?.noteInteraction();
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      // The ground canvas is also pointer-events:none while the orbital view
      // is showing, so this shouldn't fire then anyway — belt-and-suspenders
      // against a move event queued right at the transition boundary.
      if (orbitalActiveRef.current) return;

      // Hover hit-test runs regardless of dragging, so the tooltip still
      // updates (or clears, mid-drag) as the pointer crosses objects.
      const rect = canvas.getBoundingClientRect();
      const hx = e.clientX - rect.left;
      const hy = e.clientY - rect.top;
      const label = rendererRef.current?.hitTest(hx, hy) ?? null;
      setHover(label ? { x: hx, y: hy, label } : null);

      if (!dragging) return;
      const c = configRef.current;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      // Degrees-per-pixel drag sensitivity scales inversely with zoom, so a
      // drag feels consistent whether lightly or deeply zoomed in.
      const degPerPx = 0.15 / c.skyZoom;
      const nextAz = ((c.skyPanAz - dx * degPerPx) % 360 + 360) % 360;
      const nextAlt = Math.max(-10, Math.min(90, c.skyPanAlt + dy * degPerPx));
      conn.patchConfig({ skyPanAz: nextAz, skyPanAlt: nextAlt });
    };
    const onPointerLeave = () => setHover(null);
    const onPointerUp = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    };
    const onDoubleClick = () => {
      const c = configRef.current;
      if (c.projectionMode !== "sky") return;
      rendererRef.current?.noteInteraction();
      conn.patchConfig({ skyZoom: 1, skyPanAz: 0, skyPanAlt: 90 });
    };

    root.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("dblclick", onDoubleClick);
    return () => {
      root.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("dblclick", onDoubleClick);
    };
  }, [conn]);

  // Auto-hide the cursor after a few seconds of no movement (kiosk/ambient
  // look), and restore it the moment the pointer moves again.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const IDLE_MS = 2000;
    let idleTimer: ReturnType<typeof setTimeout>;
    const onActivity = () => {
      canvas.classList.remove("cursor-idle");
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => canvas.classList.add("cursor-idle"), IDLE_MS);
    };
    onActivity();
    canvas.addEventListener("pointermove", onActivity);
    canvas.addEventListener("pointerdown", onActivity);
    return () => {
      clearTimeout(idleTimer);
      canvas.removeEventListener("pointermove", onActivity);
      canvas.removeEventListener("pointerdown", onActivity);
    };
  }, []);

  // Hard tipping point, not a cross-fade: below it, only the ground dome is
  // visible/interactive; at or above it, only the orbital view is. Blending
  // both let the Earth sphere read as translucent (ground stars/satellites
  // showing through it) and left both layers' hover tooltips live at once.
  // A touch of hysteresis (different thresholds each direction) stops the
  // view flickering back and forth if pullback sits right at the boundary.
  const showOrbital = pullback >= (orbitalActiveRef.current ? 0.12 : 0.18);
  if (showOrbital !== orbitalActiveRef.current) {
    orbitalActiveRef.current = showOrbital;
    if (showOrbital && hover) setHover(null); // no stale ground-view tooltip carried over
  }

  // Render immediately from defaults regardless of connection state — this
  // display must work fully offline (embedded star/satellite/comet data,
  // real astronomy computed client-side). A missing WebSocket should never
  // block real content from showing; it only means live aircraft/shared
  // config sync aren't available yet, not that the sky can't render.
  const cfg = state.config ?? DEFAULT_CONFIG;
  const offline = !state.connected;
  return (
    <div className="display-root" ref={rootRef}>
      <canvas
        ref={canvasRef}
        className="display-canvas"
        style={showOrbital ? { visibility: "hidden", pointerEvents: "none" } : undefined}
      />
      {/* Mounted once pullback ever starts (not gated on showOrbital) and kept
          mounted thereafter — remounting on every threshold crossing would
          rebuild the WebGL context and re-fetch the Earth texture from
          scratch each time, which is what made the ground-to-orbital
          transition feel like it hung. Visibility is toggled with CSS
          instead, same as the ground canvas above. */}
      {everEnteredOrbitalRef.current && (
        <div className="orbital-overlay" style={showOrbital ? undefined : { visibility: "hidden", pointerEvents: "none" }}>
          <OrbitalView
            cfg={cfg}
            tles={tles}
            aircraft={state.aircraft}
            pullback={pullback}
            onHover={setHover}
          />
        </div>
      )}
      {cfg.showHud && (
        <div className="hud">
          <div className={`hud-dot ${state.connected ? "ok" : "bad"}`} />
          <span>
            {offline ? "offline (local defaults)" : state.status?.source ?? "—"} · {state.aircraft.length} ac ·{" "}
            rot {cfg.rotationDeg}° · mirror {cfg.mirrorX ? "X" : "–"}
            {cfg.mirrorY ? "Y" : ""} · r {formatDistance(cfg.radiusMiles, cfg.distanceUnit)} · {cfg.projectionMode} · {cfg.theme}
          </span>
        </div>
      )}
      <QuickSettings
        cfg={cfg}
        patch={(patch) => {
          rendererRef.current?.noteInteraction();
          conn.patchConfig(patch);
        }}
      />
      {hover && (
        <div className="hover-tip" style={{ left: hover.x, top: hover.y }}>
          {hover.label}
        </div>
      )}
      {!isKiosk && (
        <button
          type="button"
          className={`ambient-toggle ${ambient.active ? "on" : ""}`}
          onClick={() => ambient.toggle()}
          title={
            ambient.active
              ? "Exit ambient mode (fullscreen + keep awake) — press f"
              : "Ambient mode: fullscreen + keep screen awake — press f"
          }
          aria-label="Toggle ambient fullscreen mode"
        >
          {ambient.active ? "◱ exit ambient" : "◳ ambient"}
          {ambient.active && !ambient.wakeLocked && <span className="ambient-warn"> · no wake-lock</span>}
        </button>
      )}
    </div>
  );
}
