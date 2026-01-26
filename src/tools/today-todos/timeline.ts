import type {
  CalendarEventDetail,
  TimeBlock,
  LinearIssueDetail,
  GmailMessageDetail,
  AssignedActionDetail,
  SlackMessageDetail,
  CategorizedIssues,
  TimelineItem,
} from "./types";
import { calculateSlackPriority } from "./slack-utils";

/**
 * Calculates a priority score for quick action items (emails, doc comments)
 * Higher score = higher priority
 */
export function calculateQuickActionPriority(
  item: { 
    type: "email" | "doc"; 
    timestamp?: string | number; 
    isAssignment?: boolean; 
    isImportant?: boolean;
    isFromIndividual?: boolean;
    needsReply?: boolean;
    hasActionItems?: boolean;
  },
  now: Date
): number {
  let score = 0;
  
  // Base priority by type
  if (item.type === "doc") {
    // Assignments are more urgent than mentions
    if (item.isAssignment) {
      score += 100; // High priority for assignments
    } else {
      score += 50; // Medium priority for mentions
    }
  } else if (item.type === "email") {
    score += 30; // Base priority for emails
    
    // Boost for emails from individuals (much higher priority)
    if (item.isFromIndividual) {
      score += 80; // Big boost for individual emails
      
      // Additional boost if it needs a reply
      if (item.needsReply) {
        score += 50; // Urgent: needs reply from individual
      }
      
      // Additional boost if it has action items
      if (item.hasActionItems) {
        score += 60; // Very urgent: action items from individual
      }
    }
    
    // Boost for important emails (even if automated)
    if (item.isImportant) {
      score += 20;
    }
  }
  
  // Recency boost: more recent = higher priority
  let itemDate: Date | null = null;
  if (item.timestamp) {
    if (typeof item.timestamp === "string") {
      itemDate = new Date(item.timestamp);
    } else {
      itemDate = new Date(item.timestamp);
    }
  }
  
  if (itemDate) {
    const hoursAgo = (now.getTime() - itemDate.getTime()) / (1000 * 60 * 60);
    // Items from last hour get big boost
    if (hoursAgo < 1) {
      score += 50;
    } else if (hoursAgo < 4) {
      score += 30;
    } else if (hoursAgo < 24) {
      score += 10;
    }
    // Items older than 24 hours get no recency boost
  }
  
  return score;
}

/**
 * Suggests work for a time block based on duration and priority
 * Optimizes for productivity by matching task complexity to available time
 */
export function suggestWorkForBlock(
  block: TimeBlock,
  categorizedIssues: CategorizedIssues,
  linearIssues: LinearIssueDetail[],
  gmailTodos: GmailMessageDetail[],
  assignedActions: AssignedActionDetail[],
  slackMessages: SlackMessageDetail[],
  usedIssueIds: Set<string> = new Set()
): { title: string; description?: string; links: TimelineItem["links"]; issueId?: string } | null {
  console.log(`[suggestWorkForBlock] Block: ${block.durationMinutes} min at ${block.start.toLocaleTimeString()}. Slack messages available: ${slackMessages.length}`);
  const { overdue, dueToday, highPriority, dueThisWeek, noDueDate } = categorizedIssues;
  const priorityEmojis: Record<number, string> = { 0: "⚪", 1: "🔴", 2: "🟠", 3: "🟡", 4: "🟢" };
  
  // Helper to find an unused issue from a list
  const findUnusedIssue = (issues: LinearIssueDetail[]): LinearIssueDetail | null => {
    return issues.find(i => !usedIssueIds.has(i.identifier)) || null;
  };
  
  // SHORT BLOCKS (< 30 min): Quick wins - prioritize by urgency and recency
  if (block.durationMinutes < 30) {
    const now = new Date();
    const quickActions: Array<{
      type: "email" | "doc" | "slack";
      priority: number;
      data: GmailMessageDetail | AssignedActionDetail | SlackMessageDetail;
    }> = [];

    // Add doc actions with priority scores
    for (const action of assignedActions) {
      quickActions.push({
        type: "doc",
        priority: calculateQuickActionPriority(
          { type: "doc", timestamp: action.timestamp, isAssignment: action.isAssignment },
          now
        ),
        data: action,
      });
    }

    // Add emails with priority scores
    for (const email of gmailTodos) {
      quickActions.push({
        type: "email",
        priority: calculateQuickActionPriority(
          {
            type: "email",
            timestamp: email.timestamp,
            isImportant: email.isImportant,
            isFromIndividual: email.isFromIndividual,
            needsReply: email.needsReply,
            hasActionItems: email.hasActionItems,
          },
          now
        ),
        data: email,
      });
    }

    // Add Slack messages with priority scores
    for (const slack of slackMessages) {
      const priority = calculateSlackPriority(slack, now);
      console.log(`Adding Slack to quick actions - Priority: ${priority}, Text: "${slack.text.substring(0, 50)}..."`);
      quickActions.push({
        type: "slack",
        priority,
        data: slack,
      });
    }

    // Sort by priority (highest first) and take the top item
    if (quickActions.length > 0) {
      quickActions.sort((a, b) => b.priority - a.priority);
      console.log(`Quick actions sorted. Top: ${quickActions[0].type} (priority: ${quickActions[0].priority})`);
      const topAction = quickActions[0];

      if (topAction.type === "doc") {
        const action = topAction.data as AssignedActionDetail;
        return {
          title: "Quick: Doc review",
          description: `${action.fileTitle} (${action.actionType})`,
          links: action.fileLink ? { docs: action.fileLink } : {},
        };
      } else if (topAction.type === "slack") {
        const slack = topAction.data as SlackMessageDetail;
        const truncatedText = slack.text.length > 60
          ? slack.text.substring(0, 57) + "..."
          : slack.text;
        const prefix = slack.type === "mention" ? "💬 @mention" : "💬 DM";
        return {
          title: `Quick: Respond to Slack ${slack.type}`,
          description: `${prefix} from ${slack.userName || slack.user}: "${truncatedText}"`,
          links: slack.permalink ? { slack: slack.permalink } : {},
        };
      } else {
        const email = topAction.data as GmailMessageDetail;
        return {
          title: "Quick: Email triage",
          description: email.subject,
          links: { gmail: email.link },
        };
      }
    }
    // Small Linear issues (low estimate)
    const smallIssue = linearIssues.find(i => !usedIssueIds.has(i.identifier) && (i.estimate === null || i.estimate <= 1));
    if (smallIssue) {
      return {
        title: `${smallIssue.identifier} - ${smallIssue.title} (${priorityEmojis[smallIssue.priority] || "⚪"} ${smallIssue.priorityLabel})`,
        description: undefined,
        links: { linear: smallIssue.url },
        issueId: smallIssue.identifier,
      };
    }
  }
  
  // MEDIUM BLOCKS (30-60 min): Focused work on urgent/important items
  if (block.durationMinutes >= 30 && block.durationMinutes < 60) {
    const now = new Date();
    const isMorningBlock = block.start.getHours() < 10; // Before 10 AM = morning catch-up time

    // Overdue first - always urgent
    const overdueIssue = findUnusedIssue(overdue);
    if (overdueIssue) {
      return {
        title: `🚨 OVERDUE: ${overdueIssue.identifier} - ${overdueIssue.title}`,
        description: undefined,
        links: { linear: overdueIssue.url },
        issueId: overdueIssue.identifier,
      };
    }

    // HIGH-PRIORITY SLACK (priority > 150) - urgent mentions/DMs compete with due today
    const urgentSlack = slackMessages
      .map(slack => ({ slack, priority: calculateSlackPriority(slack, now) }))
      .filter(item => item.priority > 150)
      .sort((a, b) => b.priority - a.priority)[0];

    if (urgentSlack) {
      const slack = urgentSlack.slack;
      const truncatedText = slack.text.length > 60
        ? slack.text.substring(0, 57) + "..."
        : slack.text;
      const prefix = slack.type === "mention" ? "💬 @mention" : "💬 DM";
      console.log(`PRIORITIZING urgent Slack message (priority: ${urgentSlack.priority}) over due-today Linear issues`);
      return {
        title: `💬 Respond to Slack ${slack.type}`,
        description: `${prefix} from ${slack.userName || slack.user}: "${truncatedText}"`,
        links: slack.permalink ? { slack: slack.permalink } : {},
      };
    }

    // Due today
    const dueTodayIssue = findUnusedIssue(dueToday);
    if (dueTodayIssue) {
      return {
        title: `${dueTodayIssue.identifier} - ${dueTodayIssue.title} (⏰ Due Today)`,
        description: undefined,
        links: { linear: dueTodayIssue.url },
        issueId: dueTodayIssue.identifier,
      };
    }

    // MORNING BLOCKS: Prioritize ALL Slack messages before high-priority Linear
    if (isMorningBlock && slackMessages.length > 0) {
      const prioritizedSlack = slackMessages
        .map(slack => ({ slack, priority: calculateSlackPriority(slack, now) }))
        .sort((a, b) => b.priority - a.priority)[0];

      const slack = prioritizedSlack.slack;
      const truncatedText = slack.text.length > 60
        ? slack.text.substring(0, 57) + "..."
        : slack.text;
      const prefix = slack.type === "mention" ? "💬 @mention" : "💬 DM";
      console.log(`MORNING BLOCK: Prioritizing Slack (priority: ${prioritizedSlack.priority}) for catch-up time`);
      return {
        title: `💬 Catch up: Slack ${slack.type}`,
        description: `${prefix} from ${slack.userName || slack.user}: "${truncatedText}"`,
        links: slack.permalink ? { slack: slack.permalink } : {},
      };
    }

    // High priority with medium estimate
    const mediumHighPriority = highPriority.find(i => !usedIssueIds.has(i.identifier) && (i.estimate === null || i.estimate <= 3));
    if (mediumHighPriority) {
      return {
        title: `${mediumHighPriority.identifier} - ${mediumHighPriority.title} (${priorityEmojis[mediumHighPriority.priority] || "⚪"} ${mediumHighPriority.priorityLabel})`,
        description: undefined,
        links: { linear: mediumHighPriority.url },
        issueId: mediumHighPriority.identifier,
      };
    }

    // MEDIUM-PRIORITY SLACK (priority 100-150) - compete with high-priority Linear
    const mediumSlack = slackMessages
      .map(slack => ({ slack, priority: calculateSlackPriority(slack, now) }))
      .filter(item => item.priority >= 100 && item.priority <= 150)
      .sort((a, b) => b.priority - a.priority)[0];

    if (mediumSlack) {
      const slack = mediumSlack.slack;
      const truncatedText = slack.text.length > 60
        ? slack.text.substring(0, 57) + "..."
        : slack.text;
      const prefix = slack.type === "mention" ? "💬 @mention" : "💬 DM";
      console.log(`Showing medium-priority Slack message (priority: ${mediumSlack.priority})`);
      return {
        title: `💬 Slack ${slack.type}`,
        description: `${prefix} from ${slack.userName || slack.user}: "${truncatedText}"`,
        links: slack.permalink ? { slack: slack.permalink } : {},
      };
    }
  }
  
  // LONG BLOCKS (60+ min): Deep work on complex/high-priority items
  if (block.durationMinutes >= 60) {
    const now = new Date();
    const isMorningBlock = block.start.getHours() < 10; // Before 10 AM = morning catch-up time
    console.log(`[LONG BLOCK] Duration: ${block.durationMinutes}min, Morning: ${isMorningBlock}, Overdue: ${overdue.length}, DueToday: ${dueToday.length}, Slack: ${slackMessages.length}`);

    // MORNING BLOCKS: Prioritize ALL Slack/Email catch-up FIRST, even before overdue
    if (isMorningBlock && (slackMessages.length > 0 || gmailTodos.length > 0 || assignedActions.length > 0)) {
      console.log(`MORNING CATCH-UP BLOCK - Showing Slack/Email before overdue Linear`);

      // Build a list of all short catch-up items using markdown bullet points
      const catchUpItems: string[] = [];

      // Add all Slack messages
      for (const slack of slackMessages) {
        const truncatedText = slack.text.length > 80
          ? slack.text.substring(0, 77) + "..."
          : slack.text;
        const prefix = slack.type === "mention" ? "@mention" : "DM";
        const slackLink = slack.permalink || "#";
        catchUpItems.push(`- 💬 [Slack ${prefix} from ${slack.userName || slack.user}](${slackLink}): "${truncatedText}"`);
      }

      // Add high-priority emails (up to 3)
      const topEmails = gmailTodos.slice(0, 3);
      for (const email of topEmails) {
        catchUpItems.push(`- 📧 [${email.subject}](${email.link})`);
      }

      // Add doc actions (up to 2)
      const topActions = assignedActions.slice(0, 2);
      for (const action of topActions) {
        const actionLink = action.fileLink || "#";
        catchUpItems.push(`- 📄 [${action.fileTitle}](${actionLink}) (${action.actionType})`);
      }

      return {
        title: "Morning Catch-up",
        description: catchUpItems.join("\n"),
        links: {},
      };
    }

    // LONG BLOCKS: Combine multiple items (quick tasks + main work)
    // Build a combined work block with urgent short items + primary Linear issue
    const blockItems: string[] = [];
    let primaryIssue: LinearIssueDetail | null = null;

    // 1. Add urgent/overdue Linear first (always priority)
    const overdueIssue = findUnusedIssue(overdue);
    if (overdueIssue) {
      primaryIssue = overdueIssue;
      blockItems.push(`- 🚨 [OVERDUE: ${overdueIssue.identifier}](${overdueIssue.url}) - ${overdueIssue.title}`);
      console.log(`Added OVERDUE issue to block: ${overdueIssue.identifier}`);
    }

    // 2. Add due-today Linear (high urgency)
    const dueTodayIssue = overdueIssue ? null : findUnusedIssue(dueToday);
    if (dueTodayIssue) {
      primaryIssue = dueTodayIssue;
      blockItems.push(`- ⏰ [${dueTodayIssue.identifier}](${dueTodayIssue.url}) - ${dueTodayIssue.title} (Due Today)`);
      console.log(`Added DUE TODAY issue to block: ${dueTodayIssue.identifier}`);
    }

    // 3. Add high-priority Slack (up to 2)
    const slackPriorities = slackMessages.map(slack => ({ slack, priority: calculateSlackPriority(slack, now) }));
    const topSlack = slackPriorities.sort((a, b) => b.priority - a.priority).slice(0, 2);
    for (const { slack } of topSlack) {
      const truncatedText = slack.text.length > 70
        ? slack.text.substring(0, 67) + "..."
        : slack.text;
      const prefix = slack.type === "mention" ? "@mention" : "DM";
      const slackLink = slack.permalink || "#";
      blockItems.push(`- 💬 [Slack ${prefix} from ${slack.userName || slack.user}](${slackLink}): "${truncatedText}"`);
    }

    // 4. Add top emails (up to 2)
    const topEmails = gmailTodos.slice(0, 2);
    for (const email of topEmails) {
      blockItems.push(`- 📧 [${email.subject}](${email.link})`);
    }

    // 5. If no primary issue yet, add urgent high-priority issues (only if due soon)
    if (!primaryIssue) {
      // Only include high-priority Linear issues if they're due this week
      const urgentHighPriority = highPriority.filter(i => {
        if (usedIssueIds.has(i.identifier)) return false;

        // Include if due this week (timing matters!)
        if (i.dueDate) {
          const dueDate = new Date(i.dueDate);
          const daysUntilDue = Math.ceil((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
          return daysUntilDue <= 7; // Due within a week
        }

        // Also include if no due date but very high priority (priority 1)
        return i.priority === 1;
      });

      const maxHighPriorityToAdd = Math.min(2, urgentHighPriority.length); // Max 2 instead of 3

      for (let i = 0; i < maxHighPriorityToAdd; i++) {
        const issue = urgentHighPriority[i];
        if (i === 0) {
          primaryIssue = issue;
        }
        const dueText = issue.dueDate ? ` (Due ${new Date(issue.dueDate).toLocaleDateString()})` : "";
        blockItems.push(`- 🔴 [${issue.identifier}](${issue.url}) - ${issue.title}${dueText}`);
        usedIssueIds.add(issue.identifier); // Mark as used so it doesn't appear in other blocks
        console.log(`Added URGENT HIGH PRIORITY issue to block: ${issue.identifier}`);
      }

      // If still no primary issue, add a large issue
      if (!primaryIssue) {
        const largeIssue = linearIssues.find(i => !usedIssueIds.has(i.identifier) && i.estimate !== null && i.estimate >= 3);
        if (largeIssue) {
          primaryIssue = largeIssue;
          blockItems.push(`- ⚫ [${largeIssue.identifier}](${largeIssue.url}) - ${largeIssue.title} (${largeIssue.estimate} pts)`);
          console.log(`Added LARGE issue to block: ${largeIssue.identifier}`);
        }
      }
    }

    // Return combined block if we have items
    if (blockItems.length > 0) {
      const title = primaryIssue
        ? `${primaryIssue.identifier} + ${blockItems.length - 1} more`
        : `Work Block (${blockItems.length} items)`;

      return {
        title,
        description: blockItems.join("\n"),
        links: primaryIssue ? { linear: primaryIssue.url } : {},
        issueId: primaryIssue?.identifier,
      };
    }
  }
  
  // FALLBACK 1: Due this week issues
  const dueThisWeekIssue = findUnusedIssue(dueThisWeek);
  if (dueThisWeekIssue) {
    console.log(`Using due-this-week Linear issue: ${dueThisWeekIssue.identifier}`);
    return {
      title: `${dueThisWeekIssue.identifier} - ${dueThisWeekIssue.title} (${priorityEmojis[dueThisWeekIssue.priority] || "⚪"} ${dueThisWeekIssue.priorityLabel})`,
      description: undefined,
      links: { linear: dueThisWeekIssue.url },
      issueId: dueThisWeekIssue.identifier,
    };
  }

  // FALLBACK 2: ALL REMAINING SLACK MESSAGES - before low-priority Linear
  const nowForFallback = new Date();
  if (slackMessages.length > 0) {
    const remainingSlack = slackMessages
      .map(slack => ({ slack, priority: calculateSlackPriority(slack, nowForFallback) }))
      .sort((a, b) => b.priority - a.priority)[0];

    const slack = remainingSlack.slack;
    const truncatedText = slack.text.length > 60
      ? slack.text.substring(0, 57) + "..."
      : slack.text;
    const prefix = slack.type === "mention" ? "💬 @mention" : "💬 DM";
    console.log(`FALLBACK: Showing Slack message (priority: ${remainingSlack.priority}) before no-due-date Linear issues`);
    return {
      title: `💬 Slack ${slack.type}`,
      description: `${prefix} from ${slack.userName || slack.user}: "${truncatedText}"`,
      links: slack.permalink ? { slack: slack.permalink } : {},
    };
  }

  // FALLBACK 3: No due date Linear issues (lowest priority)
  const noDueDateIssue = findUnusedIssue(noDueDate);
  if (noDueDateIssue) {
    console.log(`Using no-due-date Linear issue: ${noDueDateIssue.identifier}`);
    return {
      title: `${noDueDateIssue.identifier} - ${noDueDateIssue.title} (${priorityEmojis[noDueDateIssue.priority] || "⚪"} ${noDueDateIssue.priorityLabel})`,
      description: undefined,
      links: { linear: noDueDateIssue.url },
      issueId: noDueDateIssue.identifier,
    };
  }

  console.log(`No more Linear issues or Slack - checking emails/docs for block`);

  // Check remaining emails/docs/slack - prioritize by urgency
  const now = new Date();
  const fallbackActions: Array<{
    type: "email" | "doc" | "slack";
    priority: number;
    data: GmailMessageDetail | AssignedActionDetail | SlackMessageDetail;
  }> = [];

  for (const action of assignedActions) {
    fallbackActions.push({
      type: "doc",
      priority: calculateQuickActionPriority(
        { type: "doc", timestamp: action.timestamp, isAssignment: action.isAssignment },
        now
      ),
      data: action,
    });
  }

  for (const email of gmailTodos) {
    fallbackActions.push({
      type: "email",
      priority: calculateQuickActionPriority(
        {
          type: "email",
          timestamp: email.timestamp,
          isImportant: email.isImportant,
          isFromIndividual: email.isFromIndividual,
          needsReply: email.needsReply,
          hasActionItems: email.hasActionItems,
        },
        now
      ),
      data: email,
    });
  }

  for (const slack of slackMessages) {
    fallbackActions.push({
      type: "slack",
      priority: calculateSlackPriority(slack, now),
      data: slack,
    });
  }

  if (fallbackActions.length > 0) {
    fallbackActions.sort((a, b) => b.priority - a.priority);
    const topAction = fallbackActions[0];

    if (topAction.type === "doc") {
      const action = topAction.data as AssignedActionDetail;
      return {
        title: "📄 Doc action",
        description: `${action.fileTitle} (${action.actionType})`,
        links: action.fileLink ? { docs: action.fileLink } : {},
      };
    } else if (topAction.type === "slack") {
      const slack = topAction.data as SlackMessageDetail;
      const truncatedText = slack.text.length > 60
        ? slack.text.substring(0, 57) + "..."
        : slack.text;
      const prefix = slack.type === "mention" ? "💬 @mention" : "💬 DM";
      return {
        title: "💬 Slack response",
        description: `${prefix} from ${slack.userName || slack.user}: "${truncatedText}"`,
        links: slack.permalink ? { slack: slack.permalink } : {},
      };
    } else {
      const email = topAction.data as GmailMessageDetail;
      return {
        title: "📧 Email review",
        description: email.subject,
        links: { gmail: email.link },
      };
    }
  }
  
  return null;
}

/**
 * Formats a time range for display
 */
export function formatTimeRange(start: Date, end: Date, isAllDay: boolean): string {
  if (isAllDay) {
    return "All day";
  }
  const startTime = start.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const endTime = end.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${startTime} - ${endTime}`;
}

/**
 * Creates unified timeline from calendar events and work blocks
 */
export function createUnifiedTimeline(
  calendarEvents: CalendarEventDetail[],
  timeBlocks: TimeBlock[],
  categorizedIssues: CategorizedIssues,
  linearIssues: LinearIssueDetail[],
  gmailTodos: GmailMessageDetail[],
  assignedActions: AssignedActionDetail[],
  slackMessages: SlackMessageDetail[]
): TimelineItem[] {
  const timeline: TimelineItem[] = [];
  const usedIssueIds = new Set<string>(); // Track issues already assigned to blocks
  const now = new Date();

  // Sort items by priority so we always show the most urgent first
  // This ensures high-priority items from ALL sources (email, Slack, docs) get included
  const sortedGmailTodos = [...gmailTodos].sort((a, b) => {
    const priorityA = calculateQuickActionPriority({ type: "email", ...a }, now);
    const priorityB = calculateQuickActionPriority({ type: "email", ...b }, now);
    return priorityB - priorityA; // Higher priority first
  });

  const sortedAssignedActions = [...assignedActions].sort((a, b) => {
    const priorityA = calculateQuickActionPriority({ type: "doc", ...a }, now);
    const priorityB = calculateQuickActionPriority({ type: "doc", ...b }, now);
    return priorityB - priorityA;
  });

  const sortedSlackMessages = [...slackMessages].sort((a, b) => {
    const priorityA = calculateSlackPriority(a, now);
    const priorityB = calculateSlackPriority(b, now);
    return priorityB - priorityA;
  });
  
  // Add calendar events
  for (const event of calendarEvents) {
    const startRaw = event.start?.dateTime || event.start?.date;
    if (!startRaw) continue;
    
    const start = new Date(startRaw);
    // For all-day events, set end to end of day
    const isAllDay = !event.start?.dateTime;
    let end: Date;
    if (isAllDay) {
      end = new Date(start);
      end.setHours(23, 59, 59);
    } else {
      end = event.end?.dateTime ? new Date(event.end.dateTime) : start;
    }
    const title = event.summary || "Untitled";
    
    // Get meeting link
    let meetingLink = "";
    if (event.conferenceData?.entryPoints) {
      const videoEntry = event.conferenceData.entryPoints.find(
        ep => ep.entryPointType === "video"
      );
      if (videoEntry?.uri) {
        meetingLink = videoEntry.uri;
      }
    } else if (event.hangoutLink) {
      meetingLink = event.hangoutLink;
    }
    
    // Check if this is a solo focus block (no attendees or only self)
    const attendees = event.attendees || [];
    const otherAttendees = attendees.filter(a => !a.self);
    const isSoloFocusBlock = otherAttendees.length === 0 && !meetingLink;
    
    timeline.push({
      start,
      end,
      type: isSoloFocusBlock ? "focus" : "meeting",
      title: isAllDay ? `${title} (All day)` : title,
      description: event.location || undefined,
      links: {
        calendar: event.htmlLink,
        zoom: meetingLink || undefined,
      },
    });
  }
  
  // Sort time blocks by duration (longest first) for optimal task assignment
  const sortedBlocks = [...timeBlocks].sort((a, b) => b.durationMinutes - a.durationMinutes);

  console.log(`Found ${timeBlocks.length} time blocks. Calendar events: ${calendarEvents.length}. Slack messages: ${slackMessages.length}`);

  // Assign work to blocks (longest blocks get priority for deep work)
  const blockSuggestions = new Map<TimeBlock, ReturnType<typeof suggestWorkForBlock>>();
  for (const block of sortedBlocks) {
    const suggestion = suggestWorkForBlock(block, categorizedIssues, linearIssues, sortedGmailTodos, sortedAssignedActions, sortedSlackMessages, usedIssueIds);
    if (suggestion?.issueId) {
      usedIssueIds.add(suggestion.issueId);
    }
    blockSuggestions.set(block, suggestion);
  }

  // Add work blocks with suggestions (only if there are calendar events to create gaps)
  console.log(`Checking if work blocks should be added. Calendar events: ${calendarEvents.length}`);
  if (calendarEvents.length > 0) {
    for (const block of timeBlocks) {
      const suggestion = blockSuggestions.get(block);
      
      if (suggestion) {
        timeline.push({
          start: block.start,
          end: block.end,
          type: "work",
          title: suggestion.title,
          description: suggestion.description,
          links: suggestion.links,
        });
      } else if (linearIssues.length > 0 || gmailTodos.length > 0 || assignedActions.length > 0 || slackMessages.length > 0) {
        // Only show work blocks if there are tasks to work on
        timeline.push({
          start: block.start,
          end: block.end,
          type: "work",
          title: "Available Work Time",
          description: `${block.durationMinutes} minutes available`,
          links: {},
        });
      }
    }
  }

  // Sort chronologically
  timeline.sort((a, b) => a.start.getTime() - b.start.getTime());

  return timeline;
}

/**
 * Builds a clean chronological list output from unified timeline
 */
export function buildListOutput(timeline: TimelineItem[]): string {
  if (timeline.length === 0) {
    return "No items scheduled for today.";
  }
  
  let output = "";
  
  for (let i = 0; i < timeline.length; i++) {
    const item = timeline[i];
    const isAllDay = item.title.includes("(All day)");
    const timeRange = formatTimeRange(item.start, item.end, isAllDay);
    const durationMinutes = Math.round((item.end.getTime() - item.start.getTime()) / (1000 * 60));
    
    // Format time as bold header
    output += `**${timeRange}**`;
    
    if (item.type === "meeting") {
      // Calendar event - title on next line, links inline
      output += `\n📅 `;
      if (item.links.calendar) {
        output += `[${item.title}](${item.links.calendar})`;
      } else {
        output += item.title;
      }
      if (item.links.zoom) {
        output += ` | [Join](${item.links.zoom})`;
      }
      if (item.description) {
        output += `\n   ${item.description}`;
      }
    } else if (item.type === "focus") {
      // Solo calendar focus block (no other attendees)
      const hours = Math.floor(durationMinutes / 60);
      const mins = durationMinutes % 60;
      const durationStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
      
      output += ` (${durationStr})\n🎧 `;
      if (item.links.calendar) {
        output += `[${item.title}](${item.links.calendar})`;
      } else {
        output += item.title;
      }
    } else if (item.type === "work") {
      // Work block with recommendation
      const hours = Math.floor(durationMinutes / 60);
      const mins = durationMinutes % 60;
      const durationStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
      
      // Use context-appropriate emoji based on what the work block is for
      let blockEmoji = "⏰"; // Default for general work
      if (item.links.linear) {
        blockEmoji = "⚫"; // Linear tasks
      } else if (item.links.github) {
        // GitHub items - determine emoji from URL pattern
        const githubUrl = item.links.github;
        if (githubUrl.includes("/pull/")) {
          // Check if it's a review-requested PR (could check title or add metadata)
          // For now, default to assigned PR emoji, but could be enhanced
          blockEmoji = "🔀"; // Assigned PR (default)
        } else if (githubUrl.includes("/issues/")) {
          blockEmoji = "🐛"; // GitHub issue
        } else {
          blockEmoji = "🔀"; // Default GitHub
        }
      } else if (item.links.gmail) {
        blockEmoji = "📧"; // Email tasks
      } else if (item.links.docs) {
        blockEmoji = "📝"; // Google Docs
      } else if (item.links.slack) {
        blockEmoji = "💬"; // Slack message
      }
      
      output += ` — WORK BLOCK (${durationStr})\n${blockEmoji} `;
      
      // If there's a Linear link, make the issue ID in the title clickable
      if (item.links.linear) {
        // Replace issue ID in title with linked version
        const issueMatch = item.links.linear.match(/issue\/([A-Z]+-\d+)/);
        if (issueMatch) {
          const issueId = issueMatch[1];
          const linkedTitle = item.title.replace(issueId, `[${issueId}](${item.links.linear})`);
          output += linkedTitle;
        } else {
          output += `[${item.title}](${item.links.linear})`;
        }
      } else {
        output += item.title;
      }
      if (item.description) {
        // Make description a link if there's an email, doc, or slack link
        if (item.links.gmail) {
          output += `\n   [${item.description}](${item.links.gmail})`;
        } else if (item.links.docs) {
          output += `\n   [${item.description}](${item.links.docs})`;
        } else if (item.links.slack) {
          output += `\n   [${item.description}](${item.links.slack})`;
        } else {
          output += `\n   ${item.description}`;
        }
      }
    } else {
      // Email, action, or slack - make description the link
      output += `\n`;
      if (item.links.gmail && item.description) {
        output += `📧 [${item.description}](${item.links.gmail})`;
      } else if (item.links.docs && item.description) {
        output += `📝 [${item.description}](${item.links.docs})`;
      } else if (item.links.slack && item.description) {
        output += `💬 [${item.description}](${item.links.slack})`;
      } else if (item.links.github && item.description) {
        // GitHub items - determine emoji from URL
        const githubUrl = item.links.github;
        let githubEmoji = "🔀"; // Default
        if (githubUrl.includes("/pull/")) {
          githubEmoji = "🔀"; // PR (could be 👀 for review, but need more context)
        } else if (githubUrl.includes("/issues/")) {
          githubEmoji = "🐛"; // Issue
        }
        output += `${githubEmoji} [${item.description}](${item.links.github})`;
      } else {
        output += `${item.title}: ${item.description || ""}`;
      }
    }
    
    // Add consistent spacing between items (except after last item)
    if (i < timeline.length - 1) {
      output += `\n\n`;
    } else {
      output += `\n`;
    }
  }
  
  return output;
}
