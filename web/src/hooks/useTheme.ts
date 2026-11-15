import { useCallback, useEffect, useState } from "react";
import type { ThemeMode } from "../types";

const STORAGE_KEY = "uniob_theme";

function getSystemDark(): boolean {
  if (typeof window === "undefined") return true;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function readStoredTheme(): ThemeMode {
  try {
    const val = localStorage.getItem(STORAGE_KEY);
    if (val === "dark" || val === "light" || val === "system") {
      return val;
    }
  } catch {
    // ignore storage errors
  }
  return "system";
}

export function useTheme() {
  const [themeMode, setThemeModeState] = useState<ThemeMode>(readStoredTheme);
  const [systemDark, setSystemDark] = useState<boolean>(getSystemDark);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }, []);

  const resolvedTheme: "dark" | "light" =
    themeMode === "system" ? (systemDark ? "dark" : "light") : themeMode;

  useEffect(() => {
    const root = document.documentElement;
    if (resolvedTheme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute("content", resolvedTheme === "dark" ? "#090d14" : "#f3f6fa");
    }
  }, [resolvedTheme]);

  const setThemeMode = useCallback((mode: ThemeMode) => {
    setThemeModeState(mode);
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // ignore storage errors
    }
  }, []);

  const cycleTheme = useCallback(() => {
    setThemeMode(
      themeMode === "dark" ? "light" : themeMode === "light" ? "system" : "dark",
    );
  }, [themeMode, setThemeMode]);

  return { themeMode, resolvedTheme, setThemeMode, cycleTheme };
}
