import { PRIORITY_THRESHOLDS } from "../../constants";

/**
 * Shared priority utilities for all data types
 */

/**
 * Priority metadata structure attached to all items
 */
export interface PriorityMetadata {
  score: number; // 0-300 scale, higher = more urgent
  category: "critical" | "high" | "medium" | "low";
  signals: Record<string, string | number | boolean | null>; // Type-specific signals
  reasons: string[]; // Human-readable explanations
}

/**
 * Maps a numerical priority score to a category label
 *
 * @param score - Priority score (0-300)
 * @returns Category label
 */
export function categorizeScore(score: number): "critical" | "high" | "medium" | "low" {
  if (score >= PRIORITY_THRESHOLDS.CRITICAL) return "critical";
  if (score >= PRIORITY_THRESHOLDS.HIGH) return "high";
  if (score >= PRIORITY_THRESHOLDS.MEDIUM) return "medium";
  return "low";
}

/**
 * Calculates recency boost label based on age in hours
 *
 * @param ageHours - Age of the item in hours
 * @returns Recency boost label
 */
export function calculateRecencyBoost(
  ageHours: number
): "very_recent" | "recent" | "moderate" | "old" {
  if (ageHours < 1) return "very_recent";
  if (ageHours < 4) return "recent";
  if (ageHours < 24) return "moderate";
  return "old";
}

/**
 * Calculates proximity label for calendar events
 *
 * @param minutesUntilStart - Minutes until event starts (negative if already started)
 * @param minutesUntilEnd - Minutes until event ends (negative if already ended)
 * @returns Proximity label
 */
export function calculateProximity(
  minutesUntilStart: number,
  minutesUntilEnd?: number
): "past" | "happening_now" | "very_soon" | "upcoming" | "future" {
  if (minutesUntilEnd !== undefined && minutesUntilEnd <= 0) return "past";
  if (minutesUntilStart <= 5) return "happening_now";
  if (minutesUntilStart <= 30) return "very_soon";
  if (minutesUntilStart <= 120) return "upcoming";
  return "future";
}
