"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

/** Night by default, day on request. */
export function ThemeToggle() {
  const { setTheme, resolvedTheme } = useTheme();
  return (
    // One label for both looks: the server can't know which one the browser keeps, and a label that differs wouldn't be corrected on hydration.
    <button type="button" aria-label="Switch between the dark and light look" onClick={() => setTheme(resolvedTheme === "light" ? "dark" : "light")} className="relative flex size-8 items-center justify-center rounded-md hover:bg-accent">
      <Sun className="size-4 scale-100 transition-transform dark:scale-0" />
      <Moon className="absolute size-4 scale-0 transition-transform dark:scale-100" />
    </button>
  );
}
