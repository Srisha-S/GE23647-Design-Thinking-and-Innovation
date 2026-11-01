import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
const STORAGE_KEY = 'chroma-appearance-v1';
const ACCENT_KEY = 'chroma-accent-v1';
export const accentColours = [
  { id: 'yellow', name: 'Sunshine', hex: '#FFD12E', ink: '#171B2A' },
  { id: 'blue', name: 'Blue', hex: '#3366FF', ink: '#FFFFFF' },
  { id: 'orange', name: 'Orange', hex: '#FF642C', ink: '#171B2A' },
  { id: 'green', name: 'Mint', hex: '#26BD65', ink: '#111426' },
  { id: 'pink', name: 'Pink', hex: '#F25388', ink: '#111426' },
  { id: 'purple', name: 'Lilac', hex: '#AD82F1', ink: '#111426' },
] as const;
type Accent = typeof accentColours[number]['id'];
function readAccent(): Accent {
  try { const value = localStorage.getItem(ACCENT_KEY); return accentColours.find(item => item.id === value)?.id || 'yellow'; } catch { return 'yellow'; }
}
const AppearanceContext = createContext<{ theme: ThemePreference; resolvedTheme: 'light' | 'dark'; setTheme: (theme: ThemePreference) => void; accent: Accent; setAccent: (accent: Accent) => void } | null>(null);

function readTheme(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'dark' || value === 'system' ? value : 'light';
  } catch { return 'light'; }
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [theme, setPreference] = useState<ThemePreference>(readTheme);
  const [accent, setAccentPreference] = useState<Accent>(readAccent);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const resolvedTheme = theme === 'system' ? systemDark ? 'dark' : 'light' : theme;
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolvedTheme === 'dark' ? '#101113' : '#FFFFFF');
  }, [resolvedTheme]);
  useLayoutEffect(() => {
    const selected = accentColours.find(item => item.id === accent)!;
    document.documentElement.style.setProperty('--accent', selected.hex);
    document.documentElement.style.setProperty('--accent-ink', selected.ink);
  }, [accent]);
  function setTheme(value: ThemePreference) {
    setPreference(value);
    try { localStorage.setItem(STORAGE_KEY, value); } catch { /* Theme still works when storage is unavailable. */ }
  }
  function setAccent(value: Accent) {
    setAccentPreference(value);
    try { localStorage.setItem(ACCENT_KEY, value); } catch { /* The current session still applies the choice. */ }
  }
  return <AppearanceContext.Provider value={{ theme, resolvedTheme, setTheme, accent, setAccent }}>{children}</AppearanceContext.Provider>;
}

export function useAppearance() {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error('useAppearance requires AppearanceProvider.');
  return value;
}
