import type { SlackReminderDetail } from "./types";

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  reminders?: Array<{
    id: string;
    text: string;
    time: number;
    complete: boolean;
    recurring?: boolean;
    user: string;
    link?: string;
  }>;
}

export async function fetchSlackReminders(accessToken: string): Promise<SlackReminderDetail[]> {
  const response = await fetch("https://slack.com/api/reminders.list", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Slack API error: ${response.status}`);
  }

  const data = await response.json() as SlackApiResponse;

  if (!data.ok) {
    throw new Error(data.error || "Failed to fetch reminders");
  }

  const reminders = data.reminders || [];

  // Filter for incomplete reminders that are today or overdue
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);

  const todayReminders = reminders.filter((r: any) => {
    if (r.complete) return false;
    const reminderTime = new Date(r.time * 1000);
    return reminderTime <= todayEnd;
  });

  return todayReminders.map((r: any) => ({
    id: r.id,
    text: r.text,
    time: r.time * 1000, // Convert to milliseconds
    isRecurring: !!r.recurring,
    user: r.user,
    link: r.link || undefined,
  }));
}
