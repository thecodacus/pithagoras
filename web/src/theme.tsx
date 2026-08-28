import { useEffect, useState } from "react";

/**
 * Light, dark, or whatever the machine is set to.
 *
 * "system" is the default and a real option rather than a one-off starting
 * guess: someone whose desktop flips at sunset expects this to follow, and a
 * portal that decided once at first load would not.
 */
export type Theme = "light" | "dark" | "system";

const KEY = "pithagoras.theme";
const media = () => window.matchMedia("(prefers-color-scheme: light)");

export const resolve = (theme: Theme): "light" | "dark" =>
  theme === "system" ? (media().matches ? "light" : "dark") : theme;

function apply(theme: Theme) {
  const root = document.documentElement;
  // Transitions are enabled only for the moment of the change, so the whole app
  // does not fade every time something re-renders.
  root.classList.add("theme-switching");
  root.dataset.theme = resolve(theme);
  window.setTimeout(() => root.classList.remove("theme-switching"), 200);
}

function stored(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" || value === "system" ? value : "system";
  } catch {
    return "system";
  }
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(stored);

  useEffect(() => {
    apply(theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // Private mode. The theme still applies for this session.
    }
    if (theme !== "system") return;
    const mq = media();
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  return { theme, setTheme, resolved: resolve(theme) };
}
