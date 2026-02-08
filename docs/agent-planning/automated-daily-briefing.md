# Automated Daily Briefing

Get your day planned automatically every morning without opening Claude Desktop.

## Overview

This guide shows you how to create a script that:
1. Calls your `list-all-tasks-today` MCP tool at a scheduled time (e.g., 8am daily)
2. Sends the data to Claude API with the planning prompt
3. Delivers your personalized plan via email, Slack, or notification

## Option 1: Node.js Script (Recommended)

### Prerequisites

- Node.js installed
- Your todo-mcp-server running (or accessible via URL)
- Anthropic API key (get from [console.anthropic.com](https://console.anthropic.com/))

### Step 1: Create the Script

Create `scripts/daily-briefing.js`:

```javascript
#!/usr/bin/env node

import Anthropic from "@anthropic-ai/sdk";
import nodemailer from "nodemailer";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Configuration
const CONFIG = {
  // Anthropic API
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,

  // MCP Server (choose one)
  mcpCommand: "node",
  mcpArgs: ["/path/to/todo-mcp-server/dist/index.js"],
  // OR use HTTP transport if server is remote:
  // mcpUrl: "http://localhost:9005/mcp",

  // Email delivery (optional)
  email: {
    to: process.env.EMAIL_TO || "you@company.com",
    from: process.env.EMAIL_FROM || "daily-plan@company.com",
    smtp: {
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: parseInt(process.env.SMTP_PORT || "587"),
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    }
  },

  // Slack delivery (optional)
  slack: {
    webhookUrl: process.env.SLACK_WEBHOOK_URL
  }
};

// System prompt (copy from system-prompt.md)
const SYSTEM_PROMPT = `You are a daily planning assistant helping the user maximize productivity by analyzing their tasks from multiple sources. When the user asks you to help with planning, follow these instructions carefully.

### Your Role

Help users plan their day by:
1. Calling the list-all-tasks-today tool to fetch enriched task data
2. Analyzing priority metadata, dependencies, cross-references, and meeting context
3. Providing clear, actionable recommendations
4. Explaining your reasoning when prioritizing work

[... rest of system prompt ...]

7. **ALWAYS Include Links**
   - **CRITICAL:** Every item must include a clickable link
   - Use markdown link format: [Item Title](url)
   - Never mention an item without its link
   - Links make it easy for users to take action immediately
`;

async function fetchTasksFromMCP() {
  console.log("📡 Connecting to MCP server...");

  const client = new Client({
    name: "daily-briefing-client",
    version: "1.0.0"
  });

  const transport = new StdioClientTransport({
    command: CONFIG.mcpCommand,
    args: CONFIG.mcpArgs
  });

  await client.connect(transport);

  console.log("✅ Connected to MCP server");
  console.log("📊 Fetching tasks from list-all-tasks-today...");

  const result = await client.callTool({
    name: "list-all-tasks-today",
    arguments: {}
  });

  await client.close();

  return result.content;
}

async function generatePlanWithClaude(tasksData) {
  console.log("🤖 Generating plan with Claude...");

  const anthropic = new Anthropic({
    apiKey: CONFIG.anthropicApiKey
  });

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `I just called list-all-tasks-today and got this data:\n\n${JSON.stringify(tasksData, null, 2)}\n\nPlease analyze this data and create a comprehensive plan for my day including:\n1. Executive summary\n2. Time-blocked schedule\n3. Meeting preparation\n4. Dependency analysis\n5. High-signal work (cross-source mentions)\n\nRemember to include clickable links for EVERY item.`
      }
    ]
  });

  return message.content[0].text;
}

async function sendViaEmail(plan) {
  console.log("📧 Sending plan via email...");

  const transporter = nodemailer.createTransport(CONFIG.email.smtp);

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  await transporter.sendMail({
    from: CONFIG.email.from,
    to: CONFIG.email.to,
    subject: `📅 Your Daily Plan - ${today}`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px; }
          h1, h2, h3 { color: #2c3e50; }
          a { color: #3498db; text-decoration: none; }
          a:hover { text-decoration: underline; }
          pre { background: #f4f4f4; padding: 10px; border-radius: 5px; overflow-x: auto; }
          .priority-critical { color: #e74c3c; font-weight: bold; }
          .priority-high { color: #f39c12; font-weight: bold; }
          .priority-medium { color: #3498db; }
          .priority-low { color: #95a5a6; }
        </style>
      </head>
      <body>
        ${markdownToHtml(plan)}
      </body>
      </html>
    `
  });

  console.log("✅ Email sent!");
}

async function sendViaSlack(plan) {
  console.log("💬 Sending plan to Slack...");

  const response = await fetch(CONFIG.slack.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: `📅 Your Daily Plan - ${new Date().toLocaleDateString()}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: plan.substring(0, 3000) // Slack has 3000 char limit per block
          }
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`Slack webhook failed: ${response.statusText}`);
  }

  console.log("✅ Sent to Slack!");
}

function markdownToHtml(markdown) {
  // Simple markdown to HTML converter (or use a library like 'marked')
  return markdown
    .replace(/### (.*)/g, '<h3>$1</h3>')
    .replace(/## (.*)/g, '<h2>$1</h2>')
    .replace(/# (.*)/g, '<h1>$1</h1>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2">$1</a>')
    .replace(/\n/g, '<br>');
}

async function main() {
  try {
    console.log("🌅 Starting daily briefing generation...\n");

    // Step 1: Fetch tasks from MCP server
    const tasksData = await fetchTasksFromMCP();

    // Step 2: Generate plan with Claude
    const plan = await generatePlanWithClaude(tasksData);

    console.log("\n📋 Generated Plan:\n");
    console.log(plan);
    console.log("\n");

    // Step 3: Deliver the plan
    if (CONFIG.email.smtp.auth.user) {
      await sendViaEmail(plan);
    }

    if (CONFIG.slack.webhookUrl) {
      await sendViaSlack(plan);
    }

    // Also write to file for local access
    const fs = await import('fs/promises');
    const filename = `daily-plan-${new Date().toISOString().split('T')[0]}.md`;
    await fs.writeFile(filename, plan);
    console.log(`📄 Plan saved to ${filename}`);

    console.log("\n✨ Daily briefing complete!\n");

  } catch (error) {
    console.error("❌ Error generating daily briefing:", error);
    process.exit(1);
  }
}

main();
```

### Step 2: Install Dependencies

```bash
cd /Users/kimmaida/Documents/Development/todo-mcp-server
npm install @anthropic-ai/sdk @modelcontextprotocol/sdk nodemailer
```

### Step 3: Configure Environment

Create `.env.daily-briefing`:

```bash
# Anthropic API
ANTHROPIC_API_KEY=your_api_key_here

# Email delivery (optional - use Gmail, SendGrid, etc.)
EMAIL_TO=you@company.com
EMAIL_FROM=daily-plan@company.com
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_gmail@gmail.com
SMTP_PASS=your_app_password

# Slack delivery (optional)
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
```

**Gmail App Password Setup:**
1. Go to [Google Account Security](https://myaccount.google.com/security)
2. Enable 2-Step Verification
3. Generate an App Password for "Mail"
4. Use that password in `SMTP_PASS`

**Slack Webhook Setup:**
1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Create an app → Incoming Webhooks
3. Copy the webhook URL

### Step 4: Test the Script

```bash
cd /Users/kimmaida/Documents/Development/todo-mcp-server
node scripts/daily-briefing.js
```

You should see:
1. Tasks fetched from MCP server
2. Plan generated by Claude
3. Email and/or Slack message sent
4. Local file created

### Step 5: Schedule with Cron (macOS/Linux)

Edit your crontab:

```bash
crontab -e
```

Add this line to run at 8am every weekday:

```cron
0 8 * * 1-5 cd /Users/kimmaida/Documents/Development/todo-mcp-server && source .env.daily-briefing && node scripts/daily-briefing.js >> logs/daily-briefing.log 2>&1
```

Or use launchd on macOS (more reliable):

Create `~/Library/LaunchAgents/com.yourname.daily-briefing.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.yourname.daily-briefing</string>

    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/Users/kimmaida/Documents/Development/todo-mcp-server/scripts/daily-briefing.js</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
        <key>ANTHROPIC_API_KEY</key>
        <string>your_api_key_here</string>
        <key>EMAIL_TO</key>
        <string>you@company.com</string>
        <!-- Add other env vars here -->
    </dict>

    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>8</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>

    <key>StandardOutPath</key>
    <string>/Users/kimmaida/Documents/Development/todo-mcp-server/logs/daily-briefing.log</string>

    <key>StandardErrorPath</key>
    <string>/Users/kimmaida/Documents/Development/todo-mcp-server/logs/daily-briefing-error.log</string>
</dict>
</plist>
```

Load the job:

```bash
mkdir -p ~/Documents/Development/todo-mcp-server/logs
launchctl load ~/Library/LaunchAgents/com.yourname.daily-briefing.plist
```

---

## Option 2: macOS Automation (Auto-Type on Open)

Use macOS Shortcuts or AppleScript to automatically type "Plan my day" when Claude Desktop opens.

### Using Shortcuts.app

1. Open **Shortcuts.app**
2. Create new shortcut: "Daily Planning"
3. Add actions:
   - **Open App**: Claude Desktop
   - **Wait**: 2 seconds
   - **Type Text**: "Plan my day" (with Enter)
4. Add to dock or menu bar
5. Run manually each morning, OR
6. Set up automation trigger (requires additional setup)

### Using Keyboard Maestro (Paid, $36)

Keyboard Maestro can trigger actions when apps open:

1. Create new macro
2. Trigger: "Claude Desktop activates"
3. Actions:
   - Wait 1 second
   - Type "Plan my day"
   - Press Return

---

## Option 3: GitHub Actions (Cloud-Based)

Run the script in the cloud and deliver results via email/Slack.

Create `.github/workflows/daily-briefing.yml`:

```yaml
name: Daily Briefing

on:
  schedule:
    # Run at 8am UTC (adjust for your timezone)
    - cron: '0 8 * * 1-5'
  workflow_dispatch: # Allow manual trigger

jobs:
  generate-plan:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Install dependencies
        run: npm install

      - name: Generate daily briefing
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          EMAIL_TO: ${{ secrets.EMAIL_TO }}
          SMTP_USER: ${{ secrets.SMTP_USER }}
          SMTP_PASS: ${{ secrets.SMTP_PASS }}
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
        run: node scripts/daily-briefing.js
```

Add secrets to your GitHub repo: Settings → Secrets and variables → Actions

---

## Option 4: Simple Reminder (No Automation)

If you don't want to set up scripts, just create a habit:

### macOS Reminder

1. Open **Reminders.app**
2. Create reminder: "Open Claude Desktop and say 'Plan my day'"
3. Set to repeat daily at 8am

### Browser Extension (if using Claude.ai)

Create a browser bookmark with this as URL:

```
javascript:document.querySelector('textarea').value='Plan my day';document.querySelector('button[type=submit]').click();
```

Click the bookmark when you open Claude.ai.

---

## Comparison

| Option | Pros | Cons | Cost |
|--------|------|------|------|
| **Node.js Script** | Fully automated, flexible delivery, no manual action | Requires setup, uses Claude API credits | Claude API usage (~$0.01/day) |
| **macOS Automation** | Simple, uses Claude Desktop (no API cost) | Requires manual trigger or Keyboard Maestro | Free (or $36 for Keyboard Maestro) |
| **GitHub Actions** | Cloud-based, no local dependency | Requires cloud access to MCP server | Claude API usage + GitHub Actions minutes |
| **Simple Reminder** | Zero setup, no cost | Requires manual action every day | Free |

---

## Recommended Setup

For you, I'd recommend **Option 1 (Node.js Script)** because:

1. Fully automated (set it and forget it)
2. You already have the MCP server running
3. You can receive the plan via email/Slack before even opening your computer
4. Claude API cost is minimal (~$0.01-0.05 per day depending on task volume)
5. You can customize the prompt and delivery method

**Pro tip**: Use the script to send the plan to Slack so you can read it on your phone during your morning routine!

---

## Next Steps

1. Choose which option you want to try
2. If using Option 1 (automated script), I can help you:
   - Set up the script
   - Configure email or Slack delivery
   - Schedule it with launchd
3. Test it manually first to make sure it works
4. Schedule it to run automatically

Let me know which option you'd like to implement!
