// Date helpers - format timestamps and due dates

/**
 * Parse a date string into a local-timezone Date.
 *
 * Date-only strings like "2026-02-13" are parsed as UTC midnight by the spec,
 * which shifts to the previous calendar day in US timezones.  This helper
 * detects date-only strings and constructs a local Date instead.
 * Full ISO-8601 strings (with "T") are left to the default parser.
 */
export function parseDate(dateStr: string): Date {
  // Date-only: "YYYY-MM-DD" (no "T" or time component)
  // Match date-only strings (no "T" time component). Full ISO-8601 like
  // "2026-02-12T15:00:00-05:00" must fall through to new Date() so times are preserved.
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})(?!\S)/);
  if (match) {
    return new Date(parseInt(match[1], 10), parseInt(match[2], 10) - 1, parseInt(match[3], 10));
  }
  return new Date(dateStr);
}

/**
 * Format ISO timestamp to readable date (e.g., "Jan 15, 2026")
 */
export function formatDate(timestamp: string): string {
  const date = parseDate(timestamp);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Format ISO timestamp to time (e.g., "2:30 PM")
 */
export function formatTime(timestamp: string): string {
  const date = parseDate(timestamp);
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Format due date with absolute times (no relative offsets that drift).
 * Uses "Due 3:30 PM" for today, "Due tomorrow", "Due in 3 days", etc.
 */
export function formatDueDate(dueDate: string): {
  text: string;
  isOverdue: boolean;
  isUrgent: boolean;
} {
  const due = parseDate(dueDate);
  const now = new Date();
  const hasTime = dueDate.includes("T");

  // Date-only due dates (e.g. Linear's "2026-02-13") mean "due on this day",
  // not "due at midnight". Use end-of-day for the overdue comparison and
  // show "Due today" instead of a meaningless clock time.
  const compareDate = hasTime
    ? due
    : new Date(due.getFullYear(), due.getMonth(), due.getDate(), 23, 59, 59);
  const diffMs = compareDate.getTime() - now.getTime();
  const diffHour = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDay = Math.floor(diffHour / 24);

  if (diffMs < 0) {
    // Overdue
    if (isToday(dueDate)) {
      return {
        text: hasTime ? `Overdue (was ${formatTime(dueDate)})` : "Overdue (today)",
        isOverdue: true,
        isUrgent: true,
      };
    }
    return {
      text: `Overdue (was ${formatDate(dueDate)})`,
      isOverdue: true,
      isUrgent: true,
    };
  }

  // Future due date
  if (isToday(dueDate)) {
    return {
      text: hasTime ? `Due ${formatTime(dueDate)}` : "Due today",
      isOverdue: false,
      isUrgent: hasTime ? diffHour < 4 : true,
    };
  } else if (diffDay <= 1) {
    return {
      text: "Due tomorrow",
      isOverdue: false,
      isUrgent: false,
    };
  } else if (diffDay < 7) {
    return {
      text: `Due in ${diffDay} days`,
      isOverdue: false,
      isUrgent: false,
    };
  } else {
    return {
      text: `Due ${formatDate(dueDate)}`,
      isOverdue: false,
      isUrgent: false,
    };
  }
}

/**
 * Smart date display: show time only if today, otherwise show date
 */
export function formatSmartDate(timestamp: string): string {
  return isToday(timestamp) ? formatTime(timestamp) : formatDate(timestamp);
}

/**
 * Check if a date is today
 */
export function isToday(timestamp: string): boolean {
  const date = parseDate(timestamp);
  const today = new Date();

  return (
    date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear()
  );
}

/**
 * Check if a date is this week
 */
export function isThisWeek(timestamp: string): boolean {
  const date = parseDate(timestamp);
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay()); // Start of week (Sunday)
  weekStart.setHours(0, 0, 0, 0);

  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 7); // End of week

  return date >= weekStart && date < weekEnd;
}
