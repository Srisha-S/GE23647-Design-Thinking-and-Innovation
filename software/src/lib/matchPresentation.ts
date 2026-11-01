/** Indicative visual score using the existing 0–20 Delta E display scale; not a measured probability. */
export function indicativeMatchPercent(difference: number): number {
  return Number.isFinite(difference) ? Math.max(0, Math.min(100, Math.round(100 - difference / 20 * 100))) : 0;
}
