// Annual meteor showers — radiant positions (J2000, drift is well under a
// degree per decade so no epoch correction is needed for a ceiling display),
// activity windows, and peak dates, per the IAU/IMO Working List of Visual
// Meteor Showers (https://www.imo.net/resources/working-list-of-meteor-showers/).
// Peak dates are the typical calendar peak; month/day only, evaluated against
// the display's local year each season.

export interface MeteorShower {
  id: string;
  name: string;
  /** Radiant right ascension, J2000 degrees. */
  ra: number;
  /** Radiant declination, J2000 degrees. */
  dec: number;
  /** Activity window, inclusive, month/day (year-agnostic; wraps across Jan 1). */
  startMonth: number;
  startDay: number;
  endMonth: number;
  endDay: number;
  peakMonth: number;
  peakDay: number;
  /** Zenithal Hourly Rate at peak — the theoretical rate under ideal conditions;
   *  used only to weight how often a simulated streak spawns. */
  zhr: number;
}

export const METEOR_SHOWERS: MeteorShower[] = [
  { id: "qua", name: "Quadrantids", ra: 230.1, dec: 49.5, startMonth: 12, startDay: 26, endMonth: 1, endDay: 16, peakMonth: 1, peakDay: 4, zhr: 110 },
  { id: "lyr", name: "Lyrids", ra: 271.4, dec: 33.6, startMonth: 4, startDay: 14, endMonth: 4, endDay: 30, peakMonth: 4, peakDay: 22, zhr: 18 },
  { id: "eta", name: "Eta Aquariids", ra: 338.0, dec: -1.0, startMonth: 4, startDay: 15, endMonth: 5, endDay: 27, peakMonth: 5, peakDay: 6, zhr: 50 },
  { id: "sda", name: "Southern Delta Aquariids", ra: 339.0, dec: -16.4, startMonth: 7, startDay: 12, endMonth: 8, endDay: 23, peakMonth: 7, peakDay: 30, zhr: 25 },
  { id: "cap", name: "Alpha Capricornids", ra: 307.0, dec: -10.0, startMonth: 7, startDay: 3, endMonth: 8, endDay: 15, peakMonth: 7, peakDay: 30, zhr: 5 },
  { id: "per", name: "Perseids", ra: 48.2, dec: 58.1, startMonth: 7, startDay: 17, endMonth: 8, endDay: 24, peakMonth: 8, peakDay: 12, zhr: 100 },
  { id: "ori", name: "Orionids", ra: 95.0, dec: 15.8, startMonth: 10, startDay: 2, endMonth: 11, endDay: 7, peakMonth: 10, peakDay: 21, zhr: 20 },
  { id: "sta", name: "Southern Taurids", ra: 52.0, dec: 14.5, startMonth: 9, startDay: 10, endMonth: 11, endDay: 20, peakMonth: 11, peakDay: 5, zhr: 5 },
  { id: "nta", name: "Northern Taurids", ra: 58.0, dec: 22.7, startMonth: 10, startDay: 20, endMonth: 12, endDay: 10, peakMonth: 11, peakDay: 12, zhr: 5 },
  { id: "leo", name: "Leonids", ra: 152.0, dec: 22.0, startMonth: 11, startDay: 6, endMonth: 11, endDay: 30, peakMonth: 11, peakDay: 18, zhr: 15 },
  { id: "gem", name: "Geminids", ra: 112.3, dec: 32.6, startMonth: 12, startDay: 4, endMonth: 12, endDay: 17, peakMonth: 12, peakDay: 14, zhr: 150 },
  { id: "urs", name: "Ursids", ra: 217.0, dec: 75.4, startMonth: 12, startDay: 17, endMonth: 12, endDay: 26, peakMonth: 12, peakDay: 22, zhr: 10 },
];

function dayOfYear(month: number, day: number, isLeap: boolean): number {
  const cum = [0, 31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30];
  let n = day;
  for (let m = 1; m < month; m++) n += cum[m];
  return n;
}

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** Fraction of peak ZHR active right now (0 outside the window, ramps up to
 *  the peak day and back down — a simple triangular window around the peak). */
export function activityFraction(shower: MeteorShower, date: Date): number {
  const y = date.getUTCFullYear();
  const leap = isLeapYear(y);
  const yearLen = leap ? 366 : 365;
  let doy = dayOfYear(date.getUTCMonth() + 1, date.getUTCDate(), leap);
  let start = dayOfYear(shower.startMonth, shower.startDay, leap);
  let end = dayOfYear(shower.endMonth, shower.endDay, leap);
  let peak = dayOfYear(shower.peakMonth, shower.peakDay, leap);

  // Window wraps across the new year (e.g. Quadrantids: Dec 26 -> Jan 16).
  if (end < start) {
    if (doy < start) doy += yearLen;
    end += yearLen;
    if (peak < start) peak += yearLen;
  }
  if (doy < start || doy > end) return 0;
  const beforePeak = peak - start || 1;
  const afterPeak = end - peak || 1;
  return doy <= peak
    ? (doy - start) / beforePeak
    : 1 - (doy - peak) / afterPeak;
}

/** Showers active right now (nonzero activity fraction), sorted by fraction desc. */
export function activeShowers(date: Date): { shower: MeteorShower; fraction: number }[] {
  return METEOR_SHOWERS
    .map((shower) => ({ shower, fraction: activityFraction(shower, date) }))
    .filter((s) => s.fraction > 0)
    .sort((a, b) => b.fraction - a.fraction);
}
