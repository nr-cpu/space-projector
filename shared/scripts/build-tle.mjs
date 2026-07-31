// One-time/rebuildable snapshot: Celestrak starlink TLEs -> shared/src/tle-embedded.ts
//
// Bakes a static satellite snapshot into the bundle so the display has real
// satellites to show with zero network access (offline/first-boot/appliance
// use). The live TleStore (server/src/tle.ts) still refreshes from Celestrak
// continuously when a network is available and takes priority whenever it
// has data — this embedded set is only the cold-start/offline fallback.
//
// TLEs go stale (accuracy degrades over days-to-weeks as orbits drift), so
// this snapshot should be regenerated periodically, not treated as a
// one-time asset. Regenerate with: node shared/scripts/build-tle.mjs

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, "../src/tle-embedded.ts");
// The running server (server/src/tle.ts, TleStore) already maintains a
// continuously-refreshed on-disk cache of the same feed. Prefer that when
// present and fresh (<24h) — it saves a redundant fetch and sidesteps
// Celestrak's per-IP throttling/blocking of ad-hoc script requests, which is
// stricter than what it allows a long-running server connection.
const SERVER_CACHE_PATH = resolve(__dirname, "../../server/data/tle-cache.json");

function parseTle(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length);
  const out = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].startsWith("1 ") && lines[i + 1]?.startsWith("2 ")) {
      const name = (lines[i - 1] ?? "SAT").replace(/^0 /, "").trim();
      out.push({ name, line1: lines[i], line2: lines[i + 1] });
      i++;
    }
  }
  return out;
}

let tles;
let fetchedAt = new Date();

if (existsSync(SERVER_CACHE_PATH)) {
  const cached = JSON.parse(readFileSync(SERVER_CACHE_PATH, "utf8"));
  const ageMs = Date.now() - (cached.at ?? 0);
  if (cached.tles?.length && ageMs < 24 * 3600_000) {
    tles = cached.tles;
    fetchedAt = new Date(cached.at);
    console.log(`using server/data/tle-cache.json (${Math.round(ageMs / 60000)}m old, ${tles.length} sats)`);
  }
}

if (!tles) {
  const res = await fetch(URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; space-projector-build-script/1.0)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${URL}`);
  const body = await res.text();
  tles = parseTle(body);
  if (!tles.length) {
    throw new Error(
      "fetch returned no parseable TLEs (Celestrak per-GROUP cache throttle? try again in a bit)",
    );
  }
}

const header = `// Embedded satellite snapshot — ${tles.length} objects from Celestrak
// (GROUP=starlink), fetched ${fetchedAt.toISOString()}. Public data,
// https://celestrak.org. This is the offline/cold-start fallback the
// display seeds from immediately; the live TleStore (server/src/tle.ts)
// overwrites it with fresh data whenever the network is reachable.
//
// TLEs drift stale over days-to-weeks — regenerate periodically with
// shared/scripts/build-tle.mjs, don't treat this as a one-time asset.

import type { Tle } from "./celestial.js";

export const EMBEDDED_TLE_FETCHED_AT = "${fetchedAt.toISOString()}";

export const EMBEDDED_TLES: Tle[] = ${JSON.stringify(tles)};
`;

writeFileSync(OUT_PATH, header);
console.log(`wrote ${tles.length} TLEs -> ${OUT_PATH}`);
