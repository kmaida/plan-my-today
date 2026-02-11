// Priority helpers - labels, sorting, and grouping

import type { PriorityCategory, PriorityMetadata } from "../types/tasks";

export function getPriorityLabel(category: PriorityCategory): string {
  const labels: Record<PriorityCategory, string> = {
    critical: "Critical",
    high: "High",
    medium: "Medium",
    low: "Low",
  };
  return labels[category];
}

/** Sort tasks by priority score (descending) */
export function sortByPriority<T extends { priorityMetadata: PriorityMetadata }>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) => b.priorityMetadata.score - a.priorityMetadata.score);
}

/** Group tasks by priority category */
export function groupByPriority<T extends { priorityMetadata: PriorityMetadata }>(
  tasks: T[]
): Record<PriorityCategory, T[]> {
  const groups: Record<PriorityCategory, T[]> = {
    critical: [],
    high: [],
    medium: [],
    low: [],
  };

  tasks.forEach((task) => {
    groups[task.priorityMetadata.category].push(task);
  });

  return groups;
}
