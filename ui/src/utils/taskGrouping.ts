// Task grouping - organize tasks into groups for each view mode

import { getSourceLabel } from "../components/SourceIcon";
import type { Task, TaskGroup as TaskGroupData, TaskSource, ViewMode } from "../types/tasks";
import { groupByPriority, sortByPriority } from "./priorityHelpers";
import { normalizeSource } from "./taskHelpers";

// --- Priority View (existing behavior, formalized) ---

function groupByPriorityView(tasks: Task[]): TaskGroupData[] {
  const grouped = groupByPriority(tasks);
  const categories: Array<{ key: keyof typeof grouped; label: string }> = [
    { key: "critical", label: "Critical" },
    { key: "high", label: "High" },
    { key: "medium", label: "Medium" },
    { key: "low", label: "Low" },
  ];
  return categories
    .filter((c) => grouped[c.key].length > 0)
    .map((c) => ({
      label: c.label,
      count: grouped[c.key].length,
      tasks: sortByPriority(grouped[c.key]),
    }));
}

// --- Source View ---

const SOURCE_ORDER: TaskSource[] = [
  "linear",
  "github",
  "gmail",
  "slack",
  "calendar",
  "drive",
  "meeting-notes",
];

function groupBySourceView(tasks: Task[]): TaskGroupData[] {
  const buckets = new Map<TaskSource, Task[]>();
  for (const task of tasks) {
    const key = normalizeSource(task.source);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(task);
  }
  return SOURCE_ORDER.filter((s) => buckets.has(s)).map((s) => ({
    label: getSourceLabel(s),
    count: buckets.get(s)!.length,
    tasks: sortByPriority(buckets.get(s)!),
  }));
}

// --- Public entry point ---

export function groupTasks(tasks: Task[], viewMode: ViewMode): TaskGroupData[] {
  switch (viewMode) {
    case "priority":
      return groupByPriorityView(tasks);
    case "source":
      return groupBySourceView(tasks);
  }
}
