// One-time/rebuildable conversion: Yale Bright Star Catalog (bsc5.json, MIT —
// github.com/brettonw/YaleBrightStarCatalog) -> shared/src/stars-deep.ts.
//
// Produces the dense faint-star background field, distinct from the small
// named/labeled catalog in stars.ts (constellations + label-worthy stars).
// Deep-field stars are unnamed by design (rendered faint, unlabeled) unless
// they already coincide with a named star, in which case we skip them here
// to avoid double-drawing (stars.ts already covers those).
//
// Run: node shared/scripts/build-deep-stars.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_PATH = resolve(__dirname, "../src/bsc5-raw.json");
const OUT_PATH = resolve(__dirname, "../src/stars-deep.ts");

function parseRA(s) {
  // "00h 05m 09.9s" -> decimal degrees
  const m = /(\d+)h\s*(\d+)m\s*([\d.]+)s/.exec(s);
  if (!m) return null;
  const [, h, min, sec] = m;
  return (Number(h) + Number(min) / 60 + Number(sec) / 3600) * 15;
}

function parseDec(s) {
  // "+45° 13′ 45″" -> decimal degrees
  const m = /([+-]?\d+)°\s*(\d+)['′]\s*([\d.]+)/.exec(s);
  if (!m) return null;
  const [, d, min, sec] = m;
  const sign = d.startsWith("-") ? -1 : 1;
  return sign * (Math.abs(Number(d)) + Number(min) / 60 + Number(sec) / 3600);
}

const raw = JSON.parse(readFileSync(RAW_PATH, "utf8"));

const stars = [];
for (const s of raw) {
  const ra = parseRA(s.RA);
  const dec = parseDec(s.Dec);
  const mag = Number(s.Vmag);
  if (ra == null || dec == null || !Number.isFinite(mag)) continue;
  stars.push({
    id: `hr${s.HR}`,
    ra: Math.round(ra * 1e4) / 1e4,
    dec: Math.round(dec * 1e4) / 1e4,
    mag: Math.round(mag * 100) / 100,
  });
}

stars.sort((a, b) => a.mag - b.mag);

const header = `// Dense faint-star background field — Yale Bright Star Catalog (BSC5),
// ${stars.length} stars, converted from bsc5.json (MIT License,
// https://github.com/brettonw/YaleBrightStarCatalog, itself derived from the
// public-domain Yale/CDS Bright Star Catalogue). Regenerate with
// shared/scripts/build-deep-stars.mjs.
//
// Unnamed by design — these render faint and unlabeled as sky texture. The
// small curated list in stars.ts (constellation stars + names) is drawn and
// labeled separately.

export interface DeepStar {
  id: string;
  ra: number; // degrees, J2000
  dec: number; // degrees, J2000
  mag: number; // visual magnitude
}

export const DEEP_STARS: DeepStar[] = ${JSON.stringify(stars)};
`;

writeFileSync(OUT_PATH, header);
console.log(`wrote ${stars.length} stars -> ${OUT_PATH}`);
