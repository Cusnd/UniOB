import { useCallback, useEffect, useState } from "react";
import type {
  AccentPreset,
  DensityMode,
  FleetViewMode,
  ThemeMode,
} from "../types";

const COLOR_SCHEME_KEY = "uniob-color-scheme";
const ACCENT_KEY = "uniob-accent";
const DENSITY_KEY = "uniob-density";
const VIEW_MODE_KEY = "uniob-fleet-view";

function getSystemDark(): boolean {
  if (typeof window === "undefined") return true;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function parseThemeMode(val: string | null): ThemeMode {
  if (val === "dark" || val === "light") return val;
  return "system";
}

function parseAccent(val: string | null): AccentPreset {
  if (val === "emerald" || val === "indigo" || val === "cyan") return val;
  return "emerald";
}

function parseDensity(val: string | null): DensityMode {
  if (val === "comfortable" || val === "compact") return val;
  return "comfortable";
}

function parseViewMode(val: string | null): FleetViewMode {
  if (val === "bento" || val === "table" || val === "matrix") return val;
  return "bento";
}

function safeGetStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function useHorizonPrefs() {
  const [themeMode, setThemeModeState] = useState<ThemeMode>(() =>
    parseThemeMode(safeGetStorage(COLOR_SCHEME_KEY)),
  );
  const [systemDark, setSystemDark] = useState<boolean>(getSystemDark);
  const [accent, setAccentState] = useState<AccentPreset>(() =>
    parseAccent(safeGetStorage(ACCENT_KEY)),
  );
  const [density, setDensityState] = useState<DensityMode>(() =>
    parseDensity(safeGetStorage(DENSITY_KEY)),
  );
  const [viewMode, setViewModeState] = useState<FleetViewMode>(() =>
    parseViewMode(safeGetStorage(VIEW_MODE_KEY)),
  );

  // Follow OS color-scheme changes without ever wiping pinned user preference
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }, []);

  // Cross-tab preference sync via storage events
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === COLOR_SCHEME_KEY) {
        setThemeModeState(parseThemeMode(e.newValue));
      }
      if (e.key === null || e.key === ACCENT_KEY) {
        setAccentState(parseAccent(e.newValue));
      }
      if (e.key === null || e.key === DENSITY_KEY) {
        setDensityState(parseDensity(e.newValue));
      }
      if (e.key === null || e.key === VIEW_MODE_KEY) {
        setViewModeState(parseViewMode(e.newValue));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const resolvedTheme: "dark" | "light" =
    themeMode === "system" ? (systemDark ? "dark" : "light") : themeMode;

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = themeMode;
    root.classList.toggle("dark", resolvedTheme === "dark");

    const colorSchemeMeta = document.querySelector('meta[name="color-scheme"]');
    if (colorSchemeMeta) {
      colorSchemeMeta.setAttribute(
        "content",
        themeMode === "system" ? "light dark" : themeMode,
      );
    }

    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) {
      themeColorMeta.setAttribute(
        "content",
        resolvedTheme === "dark" ? "#07090e" : "#f5f7fa",
      );
    }
  }, [themeMode, resolvedTheme]);

  useEffect(() => {
    document.documentElement.dataset.accent = accent;
  }, [accent]);

  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);

  const setThemeMode = useCallback((mode: ThemeMode) => {
    setThemeModeState(mode);
    try {
      if (mode === "system") {
        localStorage.removeItem(COLOR_SCHEME_KEY);
      } else {
        localStorage.setItem(COLOR_SCHEME_KEY, mode);
      }
    } catch {
      // ignore storage errors
    }
  }, []);

  const cycleTheme = useCallback(() => {
    setThemeModeState((prev) => {
      const next: ThemeMode =
        prev === "dark" ? "light" : prev === "light" ? "system" : "dark";
      try {
        if (next === "system") {
          localStorage.removeItem(COLOR_SCHEME_KEY);
        } else {
          localStorage.setItem(COLOR_SCHEME_KEY, next);
        }
      } catch {
        // ignore storage errors
      }
      return next;
    });
  }, []);

  const setAccent = useCallback((next: AccentPreset) => {
    setAccentState(next);
    try {
      localStorage.setItem(ACCENT_KEY, next);
    } catch {
      // ignore storage errors
    }
  }, []);

  const setDensity = useCallback((next: DensityMode) => {
    setDensityState(next);
    try {
      localStorage.setItem(DENSITY_KEY, next);
    } catch {
      // ignore storage errors
    }
  }, []);

  const setViewMode = useCallback((next: FleetViewMode) => {
    setViewModeState(next);
    try {
      localStorage.setItem(VIEW_MODE_KEY, next);
    } catch {
      // ignore storage errors
    }
  }, []);

  return {
    themeMode,
    resolvedTheme,
    setThemeMode,
    cycleTheme,
    accent,
    setAccent,
    density,
    setDensity,
    viewMode,
    setViewMode,
  };
}
