// Fetches known-comet orbital elements from JPL's Small-Body Database (SBDB)
// Query API, caches them in memory + on disk (so the appliance still has data
// if it boots offline), and refreshes weekly. Comet orbits are refined as new
// observations come in, and new comets are discovered regularly, so — like
// the satellite TLE feed — this must keep pulling fresh data for the life of
// the device, not just once at build time.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface CometElements {
  name: string;
  /** Epoch of osculation, Julian Date (TDB). */
  epochJd: number;
  /** Eccentricity. */
  e: number;
  /** Perihelion distance, AU. */
  q: number;
  /** Inclination, degrees. */
  i: number;
  /** Argument of perihelion, degrees. */
  w: number;
  /** Longitude of ascending node, degrees. */
  om: number;
  /** Time of perihelion passage, Julian Date (TDB). */
  tp: number;
  /** Comet total absolute magnitude parameter (brightness law), if known. */
  m1?: number;
  /** Comet total magnitude slope parameter, if known. */
  k1?: number;
}

const DEFAULT_URL =
  "https://ssd-api.jpl.nasa.gov/sbdb_query.api?sb-kind=c&fields=full_name,epoch,e,q,i,w,om,tp,M1,K1";

function num(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseComets(json: unknown): CometElements[] {
  const body = json as { data?: unknown[][] };
  if (!Array.isArray(body.data)) return [];
  const out: CometElements[] = [];
  for (const row of body.data) {
    const [full_name, epoch, e, q, i, w, om, tp, m1, k1] = row as (
      | string
      | null
    )[];
    const epochJd = num(epoch);
    const eN = num(e);
    const qN = num(q);
    const iN = num(i);
    const wN = num(w);
    const omN = num(om);
    const tpN = num(tp);
    if (
      !full_name ||
      epochJd == null ||
      eN == null ||
      qN == null ||
      iN == null ||
      wN == null ||
      omN == null ||
      tpN == null
    ) {
      continue;
    }
    out.push({
      name: full_name.trim(),
      epochJd,
      e: eN,
      q: qN,
      i: iN,
      w: wN,
      om: omN,
      tp: tpN,
      m1: num(m1),
      k1: num(k1),
    });
  }
  return out;
}

export class CometStore {
  private comets: CometElements[] = [];
  private fetchedAt = 0;
  private ttlMs = 7 * 24 * 3600_000; // comet elements move slowly; weekly is plenty

  constructor(
    private cachePath: string,
    private url = process.env.COMET_URL ?? DEFAULT_URL,
  ) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.cachePath, "utf8");
      const parsed = JSON.parse(raw) as { at: number; comets: CometElements[] };
      this.comets = parsed.comets ?? [];
      this.fetchedAt = parsed.at ?? 0;
    } catch {
      /* first run */
    }
    void this.refresh();
    // Check daily; refresh() itself no-ops unless the weekly TTL has elapsed
    // (a comet feed doesn't need the satellite feed's 6-hour cadence).
    setInterval(() => void this.refresh(), 24 * 3600_000).unref?.();
  }

  async get(): Promise<CometElements[]> {
    if (Date.now() - this.fetchedAt > this.ttlMs) await this.refresh();
    return this.comets;
  }

  private async refresh(): Promise<void> {
    if (Date.now() - this.fetchedAt < this.ttlMs && this.comets.length) return;
    try {
      const res = await fetch(this.url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const comets = parseComets(await res.json());
      if (comets.length) {
        this.comets = comets;
        this.fetchedAt = Date.now();
        await mkdir(dirname(this.cachePath), { recursive: true });
        await writeFile(
          this.cachePath,
          JSON.stringify({ at: this.fetchedAt, comets }),
          "utf8",
        );
        console.log(`[comets] refreshed ${comets.length} comets`);
      }
    } catch (err) {
      console.error(
        "[comets] refresh failed (using cache):",
        err instanceof Error ? err.message : err,
      );
    }
  }
}
