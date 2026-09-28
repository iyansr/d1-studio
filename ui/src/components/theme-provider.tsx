import { type ReactNode, useEffect } from "react";

const QUERY = "(prefers-color-scheme: dark)";

/** Sets shadcn's `.dark` class from the system setting (UI-14); there is no toggle. */
export function applySystemTheme(): void {
  const dark = window.matchMedia(QUERY).matches;
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const media = window.matchMedia(QUERY);
    applySystemTheme();
    media.addEventListener("change", applySystemTheme);
    return () => media.removeEventListener("change", applySystemTheme);
  }, []);
  return children;
}
