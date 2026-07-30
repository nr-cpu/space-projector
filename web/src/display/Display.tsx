import { useEffect, useRef, useState } from "react";
import type { Config, Theme } from "@shared/index.js";
import { DEFAULT_CONFIG, formatDistance } from "@shared/index.js";
import { useStream } from "../lib/useStream.js";
import { useAmbientMode, kioskRequested } from "../lib/useAmbientMode.js";
import { Renderer } from "./renderer.js";
import { QuickSettings } from "./QuickSettings.js";

const THEMES: Theme[] = ["ambient", "telemetry", "focus"];

export function Display() {
  const { state, conn } = useStream("display");
  const ambient = useAmbientMode();
  const isKiosk = kioskRequested();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; label: string } | null>(null);

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
          conn.patchConfig({ skyZoom: 1, skyPanAz: 0, skyPanAlt: 90 });
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [conn]);

  // Sky zoom (scroll wheel / pinch) + pan (click-drag), for exploring the
  // satellite field. Only meaningful in "sky" projection mode; a no-op
  // otherwise since "map" mode has no az/alt dome to zoom into.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (e: WheelEvent) => {
      const c = configRef.current;
      if (c.projectionMode !== "sky") return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0015);
      const nextZoom = Math.max(1, Math.min(40, c.skyZoom * factor));
      conn.patchConfig({ skyZoom: nextZoom });
    };

    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const onPointerDown = (e: PointerEvent) => {
      const c = configRef.current;
      if (c.projectionMode !== "sky" || c.skyZoom <= 1) return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
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
      conn.patchConfig({ skyZoom: 1, skyPanAz: 0, skyPanAlt: 90 });
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("dblclick", onDoubleClick);
    return () => {
      canvas.removeEventListener("wheel", onWheel);
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

  const cfg = state.config;
  return (
    <div className="display-root">
      <canvas ref={canvasRef} className="display-canvas" />
      {cfg?.showHud && (
        <div className="hud">
          <div className={`hud-dot ${state.connected ? "ok" : "bad"}`} />
          <span>
            {state.status?.source ?? "—"} · {state.aircraft.length} ac ·{" "}
            rot {cfg.rotationDeg}° · mirror {cfg.mirrorX ? "X" : "–"}
            {cfg.mirrorY ? "Y" : ""} · r {formatDistance(cfg.radiusMiles, cfg.distanceUnit)} · {cfg.projectionMode} · {cfg.theme}
          </span>
        </div>
      )}
      {!state.connected && <div className="reconnect">connecting…</div>}
      {cfg && <QuickSettings cfg={cfg} patch={conn.patchConfig.bind(conn)} />}
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
