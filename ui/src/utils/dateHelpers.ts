// Date helpers - format timestamps and due dates

/**
 * Format ISO timestamp to readable date (e.g., "Jan 15, 2026")
 */
export function formatDate(timestamp: string): string {
  const date = new Date(timestamp);
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
  const date = new Date(timestamp);
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
  const due = new Date(dueDate);
  const now = new Date();
  const diffMs = due.getTime() - now.getTime();
  const diffHour = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDay = Math.floor(diffHour / 24);

  if (diffMs < 0) {
    // Overdue
    if (isToday(dueDate)) {
      return {
        text: `Overdue (was ${formatTime(dueDate)})`,
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
      text: `Due ${formatTime(dueDate)}`,
      isOverdue: false,
      isUrgent: diffHour < 4,
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
  const date = new Date(timestamp);
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
  const date = new Date(timestamp);
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay()); // Start of week (Sunday)
  weekStart.setHours(0, 0, 0, 0);

  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 7); // End of week

  return date >= weekStart && date < weekEnd;
}
