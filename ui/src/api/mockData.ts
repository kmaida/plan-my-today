// Mock data matching the real server response shape (ServerTasksResponse)
// This exercises the full transformer pipeline so the UI is ready for real data

import type { ServerTasksResponse } from '../types/tasks'

const now = Date.now()

export const mockServerResponse: ServerTasksResponse = {
  calendar: [
    {
      id: 'cal-1',
      summary: 'Sprint Planning',
      start: { dateTime: new Date(now + 2 * 60 * 60 * 1000).toISOString() },
      end: { dateTime: new Date(now + 3 * 60 * 60 * 1000).toISOString() },
      htmlLink: 'https://calendar.google.com/event/cal-1',
      attendees: [
        { email: 'kim@company.com', self: true },
        { email: 'sarah@company.com', displayName: 'Sarah' },
        { email: 'mike@company.com', displayName: 'Mike' },
      ],
      priorityMetadata: {
        score: 155,
        category: 'high',
        signals: { startsIn: '2h', attendeeCount: 3, isRecurring: true },
        reasons: ['Starting in 2 hours', '3 attendees', 'Recurring meeting'],
      },
    },
  ],
  linear: [
    {
      identifier: 'KIM-42',
      title: 'Fix authentication timeout bug',
      priority: 1,
      priorityLabel: 'Urgent',
      url: 'https://linear.app/keycard/issue/KIM-42',
      state: { name: 'In Progress', type: 'started' },
      dueDate: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
      estimate: 3,
      project: { name: 'Auth Improvements' },
      priorityMetadata: {
        score: 210,
        category: 'critical',
        signals: { temporalUrgency: 'due_soon', priorityLevel: 1, daysUntilDue: 0 },
        reasons: ['Urgent priority', 'Due in 2 hours', 'In Progress'],
      },
      dependencyMetadata: {
        blockedBy: [],
        blocks: ['KIM-45'],
        waitingOn: [],
        blockedByExternal: false,
      },
      crossReferenceMetadata: {
        mentionedIn: ['slack', 'gmail'],
        relatedItems: [
          { source: 'slack', id: 'slack-1', snippet: '@kim can you look at the auth timeout?', url: 'https://slack.com/archives/C0123ABC/p1234567890' },
          { source: 'gmail', id: 'gmail-2', snippet: 'Users reporting login failures', url: 'https://mail.google.com/mail/u/0/#inbox/msg-gmail2' },
        ],
        totalMentions: 2,
      },
    },
    {
      identifier: 'KIM-45',
      title: 'Update API docs for v2 endpoints',
      priority: 3,
      priorityLabel: 'Medium',
      url: 'https://linear.app/keycard/issue/KIM-45',
      state: { name: 'Todo', type: 'unstarted' },
      dueDate: null,
      estimate: 2,
      project: { name: 'Documentation' },
      priorityMetadata: {
        score: 75,
        category: 'low',
        signals: { priorityLevel: 3, noDueDate: true },
        reasons: ['Medium priority', 'No due date'],
      },
    },
    {
      identifier: 'KIM-38',
      title: 'Migrate user settings to new schema',
      priority: 2,
      priorityLabel: 'High',
      url: 'https://linear.app/keycard/issue/KIM-38',
      state: { name: 'In Progress', type: 'started' },
      dueDate: new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString(),
      estimate: 5,
      project: { name: 'Auth Improvements' },
      priorityMetadata: {
        score: 135,
        category: 'high',
        signals: { temporalUrgency: 'due_this_week', priorityLevel: 2, estimatePoints: 5 },
        reasons: ['High priority', 'Due in 3 days', 'Large estimate (5 pts)'],
      },
    },
  ],
  gmail: [
    {
      id: 'msg-abc123',
      subject: 'Deploy hotfix before EOD',
      from: 'ceo@company.com',
      link: 'https://mail.google.com/mail/u/0/#inbox/msg-abc123',
      timestamp: now - 30 * 60 * 1000,
      isImportant: true,
      isStarred: true,
      needsReply: true,
      priorityMetadata: {
        score: 195,
        category: 'critical',
        signals: { isImportant: true, isStarred: true, needsReply: true, ageHours: 0.5 },
        reasons: ['From VIP sender', 'Starred and important', 'Needs reply', 'Recent (30m ago)'],
      },
    },
    {
      id: 'msg-def456',
      subject: 'Re: Q1 planning doc feedback',
      from: 'product@company.com',
      link: 'https://mail.google.com/mail/u/0/#inbox/msg-def456',
      timestamp: now - 4 * 60 * 60 * 1000,
      isImportant: false,
      isStarred: false,
      needsReply: true,
      priorityMetadata: {
        score: 95,
        category: 'medium',
        signals: { needsReply: true, ageHours: 4 },
        reasons: ['Needs reply', 'Received 4 hours ago'],
      },
    },
  ],
  meetingSummaries: [],
  docs: [
    {
      fileTitle: 'Sprint Retro Notes - Jan 31',
      actionType: 'comment_mention',
      fileLink: 'https://docs.google.com/document/d/abc123',
      timestamp: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
      isAssignment: true,
      priorityMetadata: {
        score: 85,
        category: 'medium',
        signals: { isAssignment: true, ageHours: 24 },
        reasons: ['Assigned to you', 'From yesterday'],
      },
    },
  ],
  github: {
    prs: [
      {
        id: 142,
        number: 142,
        title: 'feat: add OAuth token refresh flow',
        url: 'https://github.com/keycardlabs/todo-mcp-server/pull/142',
        repo: 'keycardlabs/todo-mcp-server',
        type: 'review',
        updatedAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
        isDraft: false,
        priorityMetadata: {
          score: 130,
          category: 'high',
          signals: { isReviewRequest: true, ageHours: 2, isDraft: false },
          reasons: ['Review requested', 'Updated 2 hours ago', 'Ready for review'],
        },
      },
    ],
    issues: [
      {
        id: 89,
        number: 89,
        title: 'Slack integration returns empty messages for DMs',
        url: 'https://github.com/keycardlabs/todo-mcp-server/issues/89',
        repo: 'keycardlabs/todo-mcp-server',
        updatedAt: new Date(now - 48 * 60 * 60 * 1000).toISOString(),
        labels: ['bug', 'slack'],
        priorityMetadata: {
          score: 90,
          category: 'medium',
          signals: { hasBugLabel: true, ageHours: 48 },
          reasons: ['Bug label', 'Assigned to you'],
        },
      },
    ],
  },
  slack: [
    {
      text: 'Can someone review PR #142 for the auth refactor?',
      timestamp: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
      channel: 'C0123ABC',
      channelName: '#engineering',
      user: 'U0456DEF',
      userName: 'sarah',
      permalink: 'https://slack.com/archives/C0123ABC/p1234567890',
      type: 'mention',
      priorityMetadata: {
        score: 140,
        category: 'high',
        signals: { isMention: true, isQuestion: true, ageHours: 3 },
        reasons: ['Direct mention', 'Contains question', 'Requests code review'],
      },
    },
  ],
  meetingNotes: [
    {
      documentId: 'doc-meeting-1',
      documentTitle: 'Product Sync - Feb 4',
      documentLink: 'https://docs.google.com/document/d/meeting123',
      actionItem: 'Follow up with design team on new dashboard mockups',
      assignee: 'kim',
      isUrgent: false,
      timestamp: now - 24 * 60 * 60 * 1000,
      priorityMetadata: {
        score: 70,
        category: 'low',
        signals: { isUrgent: false, ageHours: 24 },
        reasons: ['From yesterday\'s meeting', 'Not marked urgent'],
      },
    },
  ],
  metadata: {
    fetched_at: new Date().toISOString(),
    date: new Date().toISOString(),
  },
}
