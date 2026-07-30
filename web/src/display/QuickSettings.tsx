import { useState } from "react";
import type { Config } from "@shared/index.js";

interface QuickSettingsProps {
  cfg: Config;
  patch: (patch: Partial<Config>) => void;
}

/** Small orbiting-satellite glyph — the project's mark for the corner badge. */
function Logo() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="2.2" fill="#8CFFD6" />
      <ellipse
        cx="12"
        cy="12"
        rx="10"
        ry="4.2"
        stroke="#AEB6C6"
        strokeWidth="1"
        strokeOpacity="0.65"
        transform="rotate(-28 12 12)"
      />
      <circle cx="20.3" cy="6.4" r="1.5" fill="#E8ECFF" transform="rotate(-28 12 12)" />
    </svg>
  );
}

/** Corner badge — hover (or tap) reveals the 3-5 settings people reach for
 *  most often, without leaving the display. "…more settings" opens the full
 *  phone control panel for everything else. */
export function QuickSettings({ cfg, patch }: QuickSettingsProps) {
  const [open, setOpen] = useState(false);

  const toggle = (key: keyof Config) => patch({ [key]: !cfg[key] } as Partial<Config>);
  const resetView = () => patch({ skyZoom: 1, skyPanAz: 0, skyPanAlt: 90 });

  return (
    <div
      className="quick-settings"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="quick-settings-badge"
        aria-label="Quick settings"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Logo />
      </button>
      {open && (
        <div className="quick-settings-panel">
          <label className="quick-settings-row">
            <span>Satellites</span>
            <input
              type="checkbox"
              checked={cfg.showSatellites}
              onChange={() => toggle("showSatellites")}
            />
          </label>
          <label className="quick-settings-row">
            <span>Aircraft</span>
            <input
              type="checkbox"
              checked={cfg.showAircraft}
              onChange={() => toggle("showAircraft")}
            />
          </label>
          <label className="quick-settings-row">
            <span>Deep stars + Milky Way</span>
            <input
              type="checkbox"
              checked={cfg.showDeepStars && cfg.showMilkyWay}
              onChange={() =>
                patch({
                  showDeepStars: !(cfg.showDeepStars && cfg.showMilkyWay),
                  showMilkyWay: !(cfg.showDeepStars && cfg.showMilkyWay),
                })
              }
            />
          </label>
          <label className="quick-settings-row">
            <span>Comets + meteors</span>
            <input
              type="checkbox"
              checked={cfg.showComets && cfg.showMeteors}
              onChange={() =>
                patch({
                  showComets: !(cfg.showComets && cfg.showMeteors),
                  showMeteors: !(cfg.showComets && cfg.showMeteors),
                })
              }
            />
          </label>
          <button type="button" className="quick-settings-reset" onClick={resetView}>
            Reset zoom / pan
          </button>
          <a className="quick-settings-more" href="/control.html" target="_blank" rel="noopener">
            …more settings
          </a>
        </div>
      )}
    </div>
  );
}
