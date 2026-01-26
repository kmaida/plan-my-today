import type {
  CalendarEventDetail,
  TimeBlock,
  LinearIssueDetail,
  GmailMessageDetail,
  AssignedActionDetail,
  SlackReminderDetail,
  CategorizedIssues,
  TimelineItem,
} from "./types";

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
  usedIssueIds: Set<string> = new Set()
): { title: string; description?: string; links: TimelineItem["links"]; issueId?: string } | null {
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
      type: "email" | "doc";
      priority: number;
      data: GmailMessageDetail | AssignedActionDetail;
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
    
    // Sort by priority (highest first) and take the top item
    if (quickActions.length > 0) {
      quickActions.sort((a, b) => b.priority - a.priority);
      const topAction = quickActions[0];
      
      if (topAction.type === "doc") {
        const action = topAction.data as AssignedActionDetail;
        return {
          title: "Quick: Doc review",
          description: `${action.fileTitle} (${action.actionType})`,
          links: action.fileLink ? { docs: action.fileLink } : {},
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
  }
  
  // LONG BLOCKS (60+ min): Deep work on complex/high-priority items
  if (block.durationMinutes >= 60) {
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
    // High priority - perfect for deep work
    const highPriorityIssue = findUnusedIssue(highPriority);
    if (highPriorityIssue) {
      return {
        title: `${highPriorityIssue.identifier} - ${highPriorityIssue.title} (${priorityEmojis[highPriorityIssue.priority] || "⚪"} ${highPriorityIssue.priorityLabel})`,
        description: undefined,
        links: { linear: highPriorityIssue.url },
        issueId: highPriorityIssue.identifier,
      };
    }
    // Large issues (high estimate) - need long blocks
    const largeIssue = linearIssues.find(i => !usedIssueIds.has(i.identifier) && i.estimate !== null && i.estimate >= 3);
    if (largeIssue) {
      return {
        title: `${largeIssue.identifier} - ${largeIssue.title} (${largeIssue.estimate} pts)`,
        description: undefined,
        links: { linear: largeIssue.url },
        issueId: largeIssue.identifier,
      };
    }
  }
  
  // FALLBACK: Any available prioritized work
  const fallbackOrder = [...overdue, ...dueToday, ...highPriority, ...dueThisWeek, ...noDueDate];
  const fallbackIssue = fallbackOrder.find(i => !usedIssueIds.has(i.identifier));
  if (fallbackIssue) {
    return {
      title: `${fallbackIssue.identifier} - ${fallbackIssue.title} (${priorityEmojis[fallbackIssue.priority] || "⚪"} ${fallbackIssue.priorityLabel})`,
      description: undefined,
      links: { linear: fallbackIssue.url },
      issueId: fallbackIssue.identifier,
    };
  }
  
  // Check remaining emails/docs - prioritize by urgency
  const now = new Date();
  const fallbackActions: Array<{
    type: "email" | "doc";
    priority: number;
    data: GmailMessageDetail | AssignedActionDetail;
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
  slackReminders: SlackReminderDetail[] = []
): TimelineItem[] {
  const timeline: TimelineItem[] = [];
  const usedIssueIds = new Set<string>(); // Track issues already assigned to blocks
  
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
  
  // Assign work to blocks (longest blocks get priority for deep work)
  const blockSuggestions = new Map<TimeBlock, ReturnType<typeof suggestWorkForBlock>>();
  for (const block of sortedBlocks) {
    const suggestion = suggestWorkForBlock(block, categorizedIssues, linearIssues, gmailTodos, assignedActions, usedIssueIds);
    if (suggestion?.issueId) {
      usedIssueIds.add(suggestion.issueId);
    }
    blockSuggestions.set(block, suggestion);
  }
  
  // Add work blocks with suggestions (only if there are calendar events to create gaps)
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
      } else if (linearIssues.length > 0 || gmailTodos.length > 0 || assignedActions.length > 0) {
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

  // Add Slack reminders to timeline
  for (const reminder of slackReminders) {
    const reminderTime = new Date(reminder.time);
    timeline.push({
      start: reminderTime,
      end: reminderTime, // Reminders are point-in-time
      title: `🔔 Reminder: ${reminder.text}`,
      type: "reminder",
      durationMinutes: 0,
      links: {
        slack: reminder.link,
      },
    });
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
        // Make description a link if there's an email or doc link
        if (item.links.gmail) {
          output += `\n   [${item.description}](${item.links.gmail})`;
        } else if (item.links.docs) {
          output += `\n   [${item.description}](${item.links.docs})`;
        } else {
          output += `\n   ${item.description}`;
        }
      }
    } else if (item.type === "reminder") {
      // Slack reminder
      const timeStr = item.start.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
      output += `\n`;
      if (item.links.slack) {
        output += `${item.title} [View in Slack](${item.links.slack})`;
      } else {
        output += item.title;
      }
    } else {
      // Email or action - make description the link
      output += `\n`;
      if (item.links.gmail && item.description) {
        output += `📧 [${item.description}](${item.links.gmail})`;
      } else if (item.links.docs && item.description) {
        output += `📝 [${item.description}](${item.links.docs})`;
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
