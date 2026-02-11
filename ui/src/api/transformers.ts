// Transform server response types into UI Task types

import type {
  CalendarTask,
  DocsActionTask,
  GitHubTask,
  GmailTask,
  LinearTask,
  MeetingNotesTask,
  PriorityMetadata,
  ServerCalendarEvent,
  ServerDocsAction,
  ServerGitHubIssue,
  ServerGitHubPR,
  ServerGmailMessage,
  ServerLinearIssue,
  ServerMeetingNote,
  ServerPriorityMetadata,
  ServerSlackMessage,
  ServerTasksResponse,
  SlackTask,
  Task,
} from "../types/tasks";

const DEFAULT_PRIORITY: PriorityMetadata = {
  score: 0,
  category: "low",
  signals: [],
  reasons: "",
};

function transformPriority(server?: ServerPriorityMetadata): PriorityMetadata {
  if (!server) return DEFAULT_PRIORITY;
  return {
    score: server.score,
    category: server.category,
    signals: Object.keys(server.signals || {}),
    reasons: Array.isArray(server.reasons)
      ? server.reasons.join(", ")
      : String(server.reasons || ""),
  };
}

function transformLinear(issue: ServerLinearIssue): LinearTask {
  return {
    source: "linear",
    taskId: issue.taskId || "",
    identifier: issue.identifier,
    title: issue.title,
    priority: issue.priority,
    url: issue.url,
    state: issue.state?.name,
    dueDate: issue.dueDate ?? undefined,
    estimate: issue.estimate ?? undefined,
    project: issue.project?.name,
    completedAt: issue.completedAt ?? undefined,
    priorityMetadata: transformPriority(issue.priorityMetadata),
    dependencies: issue.dependencyMetadata,
    crossReferences: issue.crossReferenceMetadata,
  };
}

function transformGmail(msg: ServerGmailMessage): GmailTask {
  return {
    source: "gmail",
    taskId: msg.taskId || "",
    id: msg.id,
    subject: msg.subject,
    from: msg.from,
    link: msg.link,
    timestamp: msg.timestamp ? new Date(msg.timestamp).toISOString() : new Date().toISOString(),
    isImportant: msg.isImportant,
    isStarred: msg.isStarred,
    needsReply: msg.needsReply,
    threadMessageCount: msg.threadMessageCount,
    threadParticipants: msg.threadParticipants,
    priorityMetadata: transformPriority(msg.priorityMetadata),
  };
}

function transformGitHubPR(pr: ServerGitHubPR): GitHubTask {
  return {
    source: "github",
    taskId: pr.taskId || "",
    number: pr.number,
    title: pr.title,
    url: pr.url,
    repo: pr.repo,
    type: pr.type,
    isDraft: pr.isDraft,
    priorityMetadata: transformPriority(pr.priorityMetadata),
    crossReferences: pr.crossReferenceMetadata,
  };
}

function transformGitHubIssue(issue: ServerGitHubIssue): GitHubTask {
  return {
    source: "github-issue",
    taskId: issue.taskId || "",
    number: issue.number,
    title: issue.title,
    url: issue.url,
    repo: issue.repo,
    type: "assigned",
    labels: issue.labels,
    priorityMetadata: transformPriority(issue.priorityMetadata),
    crossReferences: issue.crossReferenceMetadata,
  };
}

function transformSlack(msg: ServerSlackMessage): SlackTask {
  return {
    source: "slack",
    taskId: msg.taskId || "",
    text: msg.text,
    title: msg.title,
    timestamp: msg.timestamp,
    channel: msg.channelName || msg.channel,
    user: msg.userName || msg.user,
    type: msg.type,
    link: msg.permalink,
    dismissalId: msg.dismissalId,
    priorityMetadata: transformPriority(msg.priorityMetadata),
  };
}

function transformCalendar(event: ServerCalendarEvent): CalendarTask {
  return {
    source: "calendar",
    taskId: event.taskId || "",
    summary: event.summary || "(No title)",
    start: event.start?.dateTime || event.start?.date || "",
    end: event.end?.dateTime || event.end?.date || "",
    location: event.location,
    attendees: event.attendees?.map((a) => ({
      email: a.email || "",
      responseStatus: undefined,
    })),
    htmlLink: event.htmlLink || "",
    priorityMetadata: transformPriority(event.priorityMetadata),
    meetingContext: event.meetingContextMetadata,
  };
}

function transformDocs(action: ServerDocsAction): DocsActionTask {
  return {
    source: "docs",
    taskId: action.taskId || "",
    fileTitle: action.fileTitle,
    actionType: action.actionType,
    fileLink: action.fileLink || "",
    timestamp: action.timestamp || new Date().toISOString(),
    priorityMetadata: transformPriority(action.priorityMetadata),
  };
}

function transformMeetingNote(note: ServerMeetingNote): MeetingNotesTask {
  return {
    source: "meeting-notes",
    taskId: note.taskId || "",
    documentId: note.documentId,
    actionItem: note.actionItem,
    assignee: note.assignee,
    isUrgent: note.isUrgent,
    timestamp:
      typeof note.timestamp === "number"
        ? new Date(note.timestamp).toISOString()
        : String(note.timestamp),
    documentLink: note.documentLink,
    priorityMetadata: transformPriority(note.priorityMetadata),
  };
}

/**
 * Flatten the grouped server response into a single Task[] array
 */
export function transformServerResponse(data: ServerTasksResponse): Task[] {
  const tasks: Task[] = [];

  if (data.calendar) tasks.push(...data.calendar.map(transformCalendar));
  if (data.linear) tasks.push(...data.linear.map(transformLinear));
  if (data.gmail) tasks.push(...data.gmail.map(transformGmail));
  if (data.github?.prs) tasks.push(...data.github.prs.map(transformGitHubPR));
  if (data.github?.issues) tasks.push(...data.github.issues.map(transformGitHubIssue));
  if (data.slack) tasks.push(...data.slack.map(transformSlack));
  if (data.docs) tasks.push(...data.docs.map(transformDocs));
  if (data.meetingNotes) tasks.push(...data.meetingNotes.map(transformMeetingNote));

  // Sort by priority score descending
  tasks.sort((a, b) => b.priorityMetadata.score - a.priorityMetadata.score);

  return tasks;
}
