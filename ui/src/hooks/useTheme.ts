import { useCallback, useEffect, useState } from "react";

type ThemePreference = "light" | "dark" | "system";
type EffectiveTheme = "light" | "dark";

const STORAGE_KEY = "theme";
const DARK_MQ = "(prefers-color-scheme: dark)";

/** Resolve a preference to the actual light/dark value. */
function resolveTheme(preference: ThemePreference): EffectiveTheme {
  if (preference === "system") {
    return window.matchMedia(DARK_MQ).matches ? "dark" : "light";
  }
  return preference;
}

/** Apply the theme to the document root so CSS `[data-theme]` selectors activate. */
function applyTheme(effective: EffectiveTheme) {
  document.documentElement.setAttribute("data-theme", effective);
}

/**
 * Read the stored preference. Falls back to "system" if nothing is stored
 * or the stored value is invalid.
 */
function readStoredPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // localStorage may be unavailable (e.g. Safari private browsing)
  }
  return "system";
}

/**
 * Three-way theme hook: light | dark | system.
 *
 * - "system" follows the OS `prefers-color-scheme` media query.
 * - Persists the user's choice to localStorage.
 * - Sets `data-theme` on `<html>` so CSS custom properties switch.
 */
export function useTheme() {
  const [theme, setThemeState] = useState<ThemePreference>(readStoredPreference);
  const [effectiveTheme, setEffectiveTheme] = useState<EffectiveTheme>(() =>
    resolveTheme(readStoredPreference())
  );

  // Apply the theme to the DOM whenever it changes.
  useEffect(() => {
    const effective = resolveTheme(theme);
    setEffectiveTheme(effective);
    applyTheme(effective);
  }, [theme]);

  // When in "system" mode, track OS preference changes.
  useEffect(() => {
    if (theme !== "system") return;

    const mq = window.matchMedia(DARK_MQ);
    const handler = () => {
      const effective = resolveTheme("system");
      setEffectiveTheme(effective);
      applyTheme(effective);
    };

    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  const setTheme = useCallback((next: ThemePreference) => {
    setThemeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Ignore write failures
    }
  }, []);

  return { theme, effectiveTheme, setTheme } as const;
}
