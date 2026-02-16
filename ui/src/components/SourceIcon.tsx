import { useSyncExternalStore } from "react";
import type { TaskSource } from "../types/tasks";
import "./SourceIcon.css";

/**
 * Observe the `data-theme` attribute on <html> so every SourceIcon re-renders
 * when the theme changes. We can't rely on useTheme() here because each call
 * creates independent state — only the App instance's setTheme fires, leaving
 * other instances stale. The DOM attribute is the single source of truth.
 */
function subscribeToTheme(callback: () => void) {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

function getEffectiveTheme(): "light" | "dark" {
  return document.documentElement.getAttribute("data-theme") === "dark"
    ? "dark"
    : "light";
}

interface SourceIconProps {
  source: TaskSource;
  showLabel?: boolean;
  size?: number;
}

const SOURCE_LABELS: Record<TaskSource, string> = {
  linear: "Linear",
  gmail: "Gmail",
  github: "GitHub",
  "github-issue": "GitHub Issues",
  slack: "Slack",
  calendar: "Calendar",
  drive: "Google Drive",
  "meeting-notes": "Meeting Notes",
};

/** Map source → public asset path. GitHub is theme-aware (see getIconPath). */
const SOURCE_ICON_PATHS: Partial<Record<TaskSource, string>> = {
  linear: "/icons/linear.svg",
  gmail: "/icons/gmail.svg",
  slack: "/icons/slack.svg",
  calendar: "/icons/calendar.svg",
  drive: "/icons/drive.svg",
  "meeting-notes": "/icons/meeting-notes.svg",
};

/**
 * Returns the icon file path for a source.
 * GitHub needs a theme-aware swap (black octocat in light, white in dark).
 */
function getIconPath(
  source: TaskSource,
  effectiveTheme: "light" | "dark",
): string | null {
  if (source === "github" || source === "github-issue") {
    return effectiveTheme === "dark"
      ? "/icons/github-dark.svg"
      : "/icons/github-light.svg";
  }
  return SOURCE_ICON_PATHS[source] ?? null;
}

/**
 * Renders a source-specific brand icon using normalized SVG files.
 * Icons live in ui/public/icons/ — all normalized to ~127px height for
 * consistent optical sizing. GitHub swaps light/dark variants based on theme.
 */
export function SourceIcon({
  source,
  showLabel = false,
  size = 16,
}: SourceIconProps) {
  const effectiveTheme = useSyncExternalStore(subscribeToTheme, getEffectiveTheme);
  const label = SOURCE_LABELS[source];
  const iconPath = getIconPath(source, effectiveTheme);

  if (!label || !iconPath) {
    return null;
  }

  return (
    <span className="source-icon" title={label}>
      <img src={iconPath} alt="" width={size} height={size} />
      {showLabel && <span className="source-icon__label">{label}</span>}
    </span>
  );
}

/** Returns the human-readable label for a task source. */
export function getSourceLabel(source: TaskSource): string {
  return SOURCE_LABELS[source] || source;
}
