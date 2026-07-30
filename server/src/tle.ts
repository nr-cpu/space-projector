// Fetches satellite TLEs (Two-Line Elements) from Celestrak, caches them in
// memory + on disk (so the appliance still has a sky if it boots offline), and
// refreshes daily. The client computes positions from these with satellite.js.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface Tle {
  name: string;
  line1: string;
  line2: string;
}

// Celestrak's full "active" catalog (~10,000 objects) returns HTTP 403 —
// Celestrak deliberately gates that endpoint against casual/scripted
// access. "starlink" alone is a real, non-blocked, thousands-of-objects
// group (SpaceX's constellation, several thousand satellites), so it's the
// default for a genuine "thousands of satellites" sky. Celestrak also
// caches each GROUP per-IP for 2 hours ("data has not updated since your
// last successful download") — expected politeness throttling, not an
// error; TleStore's refresh cadence already respects it.
//
// Override with TLE_URL for a different mix, e.g. GROUP=oneweb, GROUP=geo,
// or GROUP=visual (the original ~200-brightest-only default). Celestrak's
// gp.php does not support combining multiple GROUPs in one query.
const DEFAULT_URL =
  "https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle";

function parseTle(text: string): Tle[] {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length);
  const out: Tle[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].startsWith("1 ") && lines[i + 1]?.startsWith("2 ")) {
      const name = (lines[i - 1] ?? "SAT").replace(/^0 /, "").trim();
      out.push({ name, line1: lines[i], line2: lines[i + 1] });
      i++;
    }
  }
  return out;
}

export class TleStore {
  private tles: Tle[] = [];
  private fetchedAt = 0;
  private ttlMs = 24 * 3600_000;

  constructor(
    private cachePath: string,
    private url = process.env.TLE_URL ?? DEFAULT_URL,
  ) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.cachePath, "utf8");
      const parsed = JSON.parse(raw) as { at: number; tles: Tle[] };
      this.tles = parsed.tles ?? [];
      this.fetchedAt = parsed.at ?? 0;
    } catch {
      /* first run */
    }
    // Refresh on startup (non-blocking) and then on a daily timer.
    void this.refresh();
    setInterval(() => void this.refresh(), 6 * 3600_000).unref?.();
  }

  async get(): Promise<Tle[]> {
    if (Date.now() - this.fetchedAt > this.ttlMs) await this.refresh();
    return this.tles;
  }

  private async refresh(): Promise<void> {
    try {
      const res = await fetch(this.url, { signal: AbortSignal.timeout(15000) });
      const body = await res.text();
      // Celestrak returns HTTP 200 with a plain-text throttle notice (not an
      // error status) when a GROUP was already downloaded within its 2-hour
      // per-IP cache window — e.g. "data has not updated since your last
      // successful download". That parses to zero TLEs; treat it as a no-op
      // refresh (keep serving the existing cache) rather than a silent drop.
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tles = parseTle(body);
      if (tles.length) {
        this.tles = tles;
        this.fetchedAt = Date.now();
        await mkdir(dirname(this.cachePath), { recursive: true });
        await writeFile(
          this.cachePath,
          JSON.stringify({ at: this.fetchedAt, tles }),
          "utf8",
        );
        console.log(`[tle] refreshed ${tles.length} satellites`);
      } else {
        console.log(
          `[tle] fetch returned no parseable TLEs (likely Celestrak's per-GROUP cache throttle); keeping existing ${this.tles.length} cached`,
        );
      }
    } catch (err) {
      console.error("[tle] refresh failed (using cache):", err instanceof Error ? err.message : err);
    }
  }
}
