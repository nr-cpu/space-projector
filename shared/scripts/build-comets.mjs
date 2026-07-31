// One-time/rebuildable snapshot: JPL SBDB comet elements -> shared/src/comets-embedded.ts
//
// Bakes a static comet snapshot into the bundle so the display has real
// comets to show with zero network access. The live CometStore
// (server/src/comets.ts) still refreshes from JPL continuously when a
// network is available and takes priority whenever it has data; this
// embedded set is only the cold-start/offline fallback.
//
// Comet orbital elements are refined slowly and new comets are discovered
// regularly, so this snapshot should be regenerated occasionally, not
// treated as a one-time asset. Regenerate with:
// node shared/scripts/build-comets.mjs

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, "../src/comets-embedded.ts");

const URL =
  process.env.COMET_URL ??
  "https://ssd-api.jpl.nasa.gov/sbdb_query.api?sb-kind=c&fields=full_name,epoch,e,q,i,w,om,tp,M1,K1";

function num(v) {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseComets(json) {
  const body = json;
  if (!Array.isArray(body.data)) return [];
  const out = [];
  for (const row of body.data) {
    const [full_name, epoch, e, q, i, w, om, tp, m1, k1] = row;
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
    const c = { name: full_name.trim(), epochJd, e: eN, q: qN, i: iN, w: wN, om: omN, tp: tpN };
    const m1N = num(m1);
    const k1N = num(k1);
    if (m1N != null) c.m1 = m1N;
    if (k1N != null) c.k1 = k1N;
    out.push(c);
  }
  return out;
}

const res = await fetch(URL);
if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${URL}`);
const comets = parseComets(await res.json());
if (!comets.length) throw new Error("fetch returned no parseable comets");

const header = `// Embedded comet snapshot — ${comets.length} objects from JPL's Small-Body
// Database, fetched ${new Date().toISOString()}. Public data,
// https://ssd-api.jpl.nasa.gov. This is the offline/cold-start fallback the
// display seeds from immediately; the live CometStore (server/src/comets.ts)
// overwrites it with fresh data whenever the network is reachable.
//
// Orbital elements are refined slowly and new comets are discovered
// regularly — regenerate occasionally with shared/scripts/build-comets.mjs,
// don't treat this as a one-time asset.

import type { CometElements } from "./celestial.js";

export const EMBEDDED_COMETS_FETCHED_AT = "${new Date().toISOString()}";

export const EMBEDDED_COMETS: CometElements[] = ${JSON.stringify(comets)};
`;

writeFileSync(OUT_PATH, header);
console.log(`wrote ${comets.length} comets -> ${OUT_PATH}`);
