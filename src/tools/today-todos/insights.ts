import type {
  CalendarEventDetail,
  TimeBlock,
  LinearIssueDetail,
  GmailMessageDetail,
  AssignedActionDetail,
  CategorizedIssues,
  LookaheadItem,
} from "./types";

/**
 * Generates productivity insights based on schedule patterns
 */
export function generateProductivityInsights(
  calendarEvents: CalendarEventDetail[],
  timeBlocks: TimeBlock[],
  linearIssues: LinearIssueDetail[],
  categorizedIssues: CategorizedIssues,
  gmailTodos: GmailMessageDetail[],
  assignedActions: AssignedActionDetail[]
): string[] {
  const insights: string[] = [];
  const now = new Date();
  const currentHour = now.getHours();
  
  // Filter to timed events only
  const timedEvents = calendarEvents.filter(e => e.start?.dateTime);
  
  // Analyze overdue issues with specific recommendations
  if (categorizedIssues.overdue.length > 0) {
    const overdueCount = categorizedIssues.overdue.length;
    const overdueWithHighPriority = categorizedIssues.overdue.filter(i => i.priority <= 2);
    if (overdueWithHighPriority.length > 0) {
      const issue = overdueWithHighPriority[0];
      insights.push(`🚨 **${overdueCount} overdue issue${overdueCount > 1 ? "s" : ""}** — Start with [${issue.identifier}](${issue.url}) (${issue.priorityLabel}) as it's highest priority.`);
    } else {
      insights.push(`🚨 **${overdueCount} overdue issue${overdueCount > 1 ? "s" : ""}** — Tackle [${categorizedIssues.overdue[0].identifier}](${categorizedIssues.overdue[0].url}) first to prevent further delays.`);
    }
  } else if (categorizedIssues.dueToday.length > 0) {
    const dueTodayCount = categorizedIssues.dueToday.length;
    const totalPoints = categorizedIssues.dueToday.reduce((sum, i) => sum + (i.estimate || 1), 0);
    if (totalPoints > 5) {
      insights.push(`⏰ **${dueTodayCount} issue${dueTodayCount > 1 ? "s" : ""} due today** (${totalPoints} pts total) — Start early to avoid rushing. Consider breaking into smaller chunks.`);
    } else {
      insights.push(`⏰ **${dueTodayCount} issue${dueTodayCount > 1 ? "s" : ""} due today** — Allocate time in your schedule to complete these.`);
    }
  }
  
  // Analyze meeting density by time of day with specific recommendations
  const morningMeetings = timedEvents.filter(e => {
    const hour = new Date(e.start!.dateTime!).getHours();
    return hour >= 9 && hour < 12;
  });
  const afternoonMeetings = timedEvents.filter(e => {
    const hour = new Date(e.start!.dateTime!).getHours();
    return hour >= 12 && hour < 17;
  });
  
  if (morningMeetings.length >= 3 && afternoonMeetings.length < morningMeetings.length) {
    const afternoonBlocks = timeBlocks.filter(b => {
      const hour = b.start.getHours();
      return hour >= 12 && hour < 17;
    });
    const afternoonMinutes = afternoonBlocks.reduce((sum, b) => sum + b.durationMinutes, 0);
    if (afternoonMinutes >= 90) {
      insights.push(`🌅 **Morning is meeting-heavy** (${morningMeetings.length} meetings) — Use your ${Math.floor(afternoonMinutes / 60)}h ${afternoonMinutes % 60}m afternoon focus time for deep work on complex tasks.`);
    } else {
      insights.push(`🌅 **Morning is meeting-heavy** (${morningMeetings.length} meetings) — Protect your limited afternoon time (${afternoonMinutes} min) for your most important work.`);
    }
  } else if (afternoonMeetings.length >= 3 && morningMeetings.length < afternoonMeetings.length) {
    const morningBlocks = timeBlocks.filter(b => {
      const hour = b.start.getHours();
      return hour >= 9 && hour < 12;
    });
    const morningMinutes = morningBlocks.reduce((sum, b) => sum + b.durationMinutes, 0);
    if (morningMinutes >= 90) {
      insights.push(`☀️ **Afternoon is packed** (${afternoonMeetings.length} meetings) — Use your ${Math.floor(morningMinutes / 60)}h ${morningMinutes % 60}m morning focus time to tackle important tasks before meetings drain your energy.`);
    } else {
      insights.push(`☀️ **Afternoon is packed** (${afternoonMeetings.length} meetings) — Maximize your ${morningMinutes} min morning window for critical work.`);
    }
  }
  
  // Find longest block and suggest specific task
  if (timeBlocks.length > 0) {
    const longestBlock = timeBlocks.reduce((a, b) => a.durationMinutes > b.durationMinutes ? a : b);
    if (longestBlock.durationMinutes >= 60) {
      const blockTime = longestBlock.start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
      const hours = Math.floor(longestBlock.durationMinutes / 60);
      const mins = longestBlock.durationMinutes % 60;
      const durationStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
      
      // Find the most complex task that fits this block
      const complexTasks = categorizedIssues.overdue.length > 0 
        ? categorizedIssues.overdue 
        : categorizedIssues.dueToday.length > 0 
          ? categorizedIssues.dueToday 
          : categorizedIssues.highPriority;
      
      if (complexTasks.length > 0) {
        const bestTask = complexTasks.find(t => (t.estimate || 1) >= 3) || complexTasks[0];
        insights.push(`🎯 **${durationStr} focus block at ${blockTime}** — Perfect for [${bestTask.identifier}](${bestTask.url}) (${bestTask.estimate || "unestimated"} pts, ${bestTask.priorityLabel}). This is your best window for deep work.`);
      } else {
        insights.push(`🎯 **${durationStr} focus block at ${blockTime}** — Use this uninterrupted time for your most complex task. Block distractions and go deep.`);
      }
    }
  }
  
  // Back-to-back meeting warning with specific prep suggestions
  for (let i = 0; i < timedEvents.length - 1; i++) {
    const current = timedEvents[i];
    const next = timedEvents[i + 1];
    if (current.end?.dateTime && next.start?.dateTime) {
      const gap = (new Date(next.start.dateTime).getTime() - new Date(current.end.dateTime).getTime()) / (1000 * 60);
      if (gap <= 5 && gap >= 0) {
        // Count consecutive back-to-backs
        let backToBackCount = 2;
        for (let j = i + 1; j < timedEvents.length - 1; j++) {
          const curr = timedEvents[j];
          const nxt = timedEvents[j + 1];
          if (curr.end?.dateTime && nxt.start?.dateTime) {
            const g = (new Date(nxt.start.dateTime).getTime() - new Date(curr.end.dateTime).getTime()) / (1000 * 60);
            if (g <= 5 && g >= 0) backToBackCount++;
            else break;
          }
        }
        if (backToBackCount >= 2) {
          const startTime = new Date(current.start!.dateTime!).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
          const firstMeetingTitle = current.summary || "meeting";
          insights.push(`⚠️ **${backToBackCount} back-to-back meetings starting at ${startTime}** — Prep materials for "${firstMeetingTitle}" now to avoid context switching.`);
          break; // Only show one back-to-back warning
        }
      }
    }
  }
  
  // Email and action item analysis
  const urgentEmails = gmailTodos.filter(e => e.isFromIndividual && (e.hasActionItems || e.needsReply));
  const docActions = assignedActions.filter(a => a.isAssignment);
  
  if (urgentEmails.length > 0 || docActions.length > 0) {
    const quickWins: string[] = [];
    if (urgentEmails.length > 0) {
      quickWins.push(`${urgentEmails.length} email${urgentEmails.length > 1 ? "s" : ""} from individuals`);
    }
    if (docActions.length > 0) {
      quickWins.push(`${docActions.length} doc assignment${docActions.length > 1 ? "s" : ""}`);
    }
    
    // Find short time blocks for quick wins
    const shortBlocks = timeBlocks.filter(b => b.durationMinutes < 30 && b.durationMinutes >= 15);
    if (shortBlocks.length > 0) {
      const totalShortTime = shortBlocks.reduce((sum, b) => sum + b.durationMinutes, 0);
      insights.push(`⚡ **Quick wins available** — ${quickWins.join(" and ")} can be handled in your ${totalShortTime} min of short blocks (< 30 min). Batch process these between deep work.`);
    } else {
      insights.push(`⚡ **Quick wins** — ${quickWins.join(" and ")} need attention. Consider batching these during transition times between meetings.`);
    }
  }
  
  // Workload analysis
  const totalWorkMinutes = timeBlocks.reduce((sum, b) => sum + b.durationMinutes, 0);
  const estimatedPoints = linearIssues.reduce((sum, i) => sum + (i.estimate || 1), 0);
  const avgPointsPerHour = totalWorkMinutes > 0 ? Math.round((estimatedPoints / totalWorkMinutes) * 60) : 0;
  
  if (totalWorkMinutes < 120 && linearIssues.length > 3) {
    const urgentCount = categorizedIssues.overdue.length + categorizedIssues.dueToday.length;
    if (urgentCount > 0) {
      insights.push(`📊 **Tight schedule** (${Math.floor(totalWorkMinutes / 60)}h ${totalWorkMinutes % 60}m focus time, ${linearIssues.length} tasks) — Focus on ${urgentCount} urgent item${urgentCount > 1 ? "s" : ""} only. Defer or delegate the rest.`);
    } else {
      insights.push(`📊 **Limited focus time** (${Math.floor(totalWorkMinutes / 60)}h ${totalWorkMinutes % 60}m) — Prioritize high-impact tasks. Consider moving ${linearIssues.length - 2}+ non-urgent items to tomorrow.`);
    }
  } else if (avgPointsPerHour > 5 && totalWorkMinutes > 0) {
    insights.push(`📊 **Ambitious workload** (${estimatedPoints} pts in ${Math.floor(totalWorkMinutes / 60)}h) — ${avgPointsPerHour} pts/hour is aggressive. Consider reducing scope or extending deadlines.`);
  }
  
  // Energy and timing insights
  if (currentHour >= 9 && currentHour < 12 && timeBlocks.length > 0) {
    const morningBlocks = timeBlocks.filter(b => {
      const hour = b.start.getHours();
      return hour >= 9 && hour < 12;
    });
    if (morningBlocks.length > 0 && categorizedIssues.overdue.length > 0) {
      insights.push(`🌄 **Morning energy peak** — Use your ${morningBlocks.length} morning focus block${morningBlocks.length > 1 ? "s" : ""} for overdue work while you're fresh.`);
    }
  }
  
  // Context switching warning
  const meetingCount = timedEvents.length;
  const workBlockCount = timeBlocks.length;
  if (meetingCount >= 4 && workBlockCount >= 3) {
    insights.push(`🔄 **High context switching** (${meetingCount} meetings, ${workBlockCount} work blocks) — Batch similar tasks together. Consider time-blocking similar work to reduce mental overhead.`);
  }
  
  return insights;
}

/**
 * Generates lookahead items for upcoming prep
 */
export function generateLookahead(
  calendarEvents: CalendarEventDetail[],
  gmailTodos: GmailMessageDetail[],
  linearIssues: LinearIssueDetail[]
): LookaheadItem[] {
  const lookahead: LookaheadItem[] = [];
  const addedIssueIds = new Set<string>();
  
  // Check emails for future meeting mentions
  for (const email of gmailTodos) {
    const subject = email.subject.toLowerCase();
    // Look for meeting invites or scheduling emails
    if (subject.includes("accepted:") || subject.includes("invitation:") || subject.includes("meet")) {
      // Extract any date/time hints
      const futureMatch = email.subject.match(/\b(mon|tue|wed|thu|fri|sat|sun|tomorrow|next week)\b/i);
      if (futureMatch) {
        // Clean up subject for display
        const cleanSubject = email.subject.substring(0, 50).replace(/^(Accepted:|Invitation:)\s*/i, "");
        lookahead.push({
          text: `📧 Prep for upcoming:`,
          link: email.link,
          linkText: cleanSubject + (email.subject.length > 50 ? "..." : ""),
        });
      }
    }
  }
  
  // Check for related prep between meetings and issues
  for (const event of calendarEvents) {
    const title = (event.summary || "").toLowerCase();
    // Find Linear issues that might relate to this meeting
    for (const issue of linearIssues) {
      if (addedIssueIds.has(issue.identifier)) continue;
      const issueText = `${issue.title} ${issue.project?.name || ""}`.toLowerCase();
      // Simple keyword matching
      const eventWords = title.split(/\s+/).filter(w => w.length > 3);
      const hasOverlap = eventWords.some(word => issueText.includes(word));
      if (hasOverlap) {
        lookahead.push({
          text: `💡 "${event.summary}" relates to`,
          link: issue.url,
          linkText: issue.identifier,
        });
        addedIssueIds.add(issue.identifier);
      }
    }
  }
  
  // Upcoming deadlines
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (const issue of linearIssues) {
    if (addedIssueIds.has(issue.identifier)) continue;
    if (issue.dueDate) {
      const due = new Date(issue.dueDate);
      const daysUntil = Math.ceil((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      if (daysUntil > 0 && daysUntil <= 3) {
        const dayLabel = daysUntil === 1 ? "tomorrow" : `in ${daysUntil} days`;
        lookahead.push({
          text: `📅 Due ${dayLabel}:`,
          linkText: issue.identifier,
          link: issue.url,
        });
        addedIssueIds.add(issue.identifier);
      }
    }
  }
  
  return lookahead.slice(0, 4); // Limit to 4 items
}
