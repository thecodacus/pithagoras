import { LuMonitor, LuMoon, LuSun } from "react-icons/lu";
import { useTheme, type Theme } from "../theme";
import { msg, t } from "../i18n";

const OPTIONS: { value: Theme; icon: typeof LuSun; label: string }[] = [
  { value: "light", icon: LuSun, label: msg("Light") },
  { value: "dark", icon: LuMoon, label: msg("Dark") },
  { value: "system", icon: LuMonitor, label: msg("Match system") },
];

/**
 * Three states rather than a switch, because "follow the system" is a real
 * preference and not the absence of one — a toggle would silently pin whoever
 * flips at sunset to whichever half they happened to be in.
 */
export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();

  return (
    <div
      className="flex shrink-0 items-center gap-0.5 rounded-lg bg-raised/60 p-0.5"
      role="radiogroup"
      aria-label={t("Theme")}
    >
      {OPTIONS.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          role="radio"
          aria-checked={theme === value}
          onClick={() => setTheme(value)}
          title={t(label)}
          aria-label={t(label)}
          className={`grid h-6 w-6 place-items-center rounded-md transition ${
            theme === value
              ? "bg-surface text-fg shadow-sm"
              : "text-fg-faint hover:text-fg-muted"
          }`}
        >
          <Icon className="h-3 w-3" />
        </button>
      ))}
    </div>
  );
}
