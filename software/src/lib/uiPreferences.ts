const SCAN_ALERTS_KEY = 'chroma-scan-alerts-v1';
export function readScanAlerts(): boolean {
  try { return localStorage.getItem(SCAN_ALERTS_KEY) !== 'off'; } catch { return true; }
}
export function writeScanAlerts(enabled: boolean): boolean {
  try { localStorage.setItem(SCAN_ALERTS_KEY, enabled ? 'on' : 'off'); return true; } catch { return false; }
}
