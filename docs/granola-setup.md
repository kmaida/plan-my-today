# Granola Meeting Notes Setup

Plan My Today extracts action items from your meeting notes. Because [Granola](https://granola.ai) doesn't expose a public API, we use a **Zapier automation** to sync Granola notes into Google Drive, where the MCP server can read them.

**Pipeline:** Granola → Zapier → Google Drive → Plan My Today

## Prerequisites

- **Granola** account (free tier works)
- **Zapier** account (free tier works — this is a simple 2-step Zap)
- **Google Drive** access already configured via Keycard (see [Keycard Setup Guide](./keycard-setup.md))

## Step 1: Create a Google Drive Folder

1. In Google Drive, create a new folder for your meeting notes (e.g., "Meeting Notes")
2. Open the folder and copy the **folder ID** from the URL:

   ```
   https://drive.google.com/drive/folders/1aBcDeFgHiJkLmNoPqRsTuVwXyZ
                                          └──────── this is your folder ID ────────┘
   ```

3. Add the folder ID to your `.env` file:

   ```bash
   MEETING_NOTES_FOLDER_ID=1aBcDeFgHiJkLmNoPqRsTuVwXyZ
   ```

## Step 2: Create a Granola Folder

In Granola, create a folder (e.g., "Sync to Drive") to act as the trigger for the Zapier automation. When you save a meeting note to this folder, Zapier will sync it to Google Drive.

> You can choose which notes to sync by moving them into this folder after your meetings, or you can move all notes there by default.

## Step 3: Set Up the Zapier Zap

Create a new Zap with the following configuration:

### Trigger

- **App:** Granola
- **Event:** Note Saved to Folder
- **Folder:** Select the Granola folder you created in Step 2 (e.g., "Sync to Drive")

### Action

- **App:** Google Docs
- **Event:** Create Document from Text
- **Configuration:**
  - **Document Name:** Use the Granola note title field (this includes the meeting date/time, which is required for Plan My Today to parse the meeting date)
  - **Document Content:** Map the Granola **notes** and **transcript** fields into the document body
  - **Folder:** Select the Google Drive folder you created in Step 1

### Important: Document Title

The document title **must include the meeting date and time** for Plan My Today to parse it correctly. Granola includes this by default in the note title (e.g., "Weekly Standup - 2026-02-20T10:00:00-05:00"). Do not strip the timestamp from the title in your Zapier mapping.

## Step 4: Configure Your `.env`

Add these to your `.env` file:

```bash
# Required: Google Drive folder ID (from Step 1)
MEETING_NOTES_FOLDER_ID=1aBcDeFgHiJkLmNoPqRsTuVwXyZ

# Optional: Filter action items to your name (comma-separated variants)
USER_DISPLAY_NAME=Kim,Kim Maida,kimmaida
```

`USER_DISPLAY_NAME` filters action items so you only see ones assigned to you. If not set, all action items from all meeting notes are returned.

## How It Works

Once configured, the pipeline works automatically:

1. You save a Granola note to your sync folder
2. Zapier creates a Google Doc with the note content in your Meeting Notes folder
3. When Plan My Today fetches your tasks, it:
   - Reads recent Google Docs from the configured folder
   - Parses the meeting date from the document title
   - Extracts action items using pattern matching (checkboxes, "Action Items:" sections, TODO markers, @mentions)
   - For very recent notes (last 3 business days), supplements extraction with LLM analysis
   - Filters to your assigned items (if `USER_DISPLAY_NAME` is set)
   - Scores items by recency and urgency

## Troubleshooting

| Problem | Likely Cause | Fix |
|---------|-------------|-----|
| No meeting notes appear | `MEETING_NOTES_FOLDER_ID` not set or incorrect | Check the folder ID in your `.env` matches the one from the Google Drive URL |
| Notes appear but no action items extracted | Notes don't contain recognizable patterns | Use checkboxes (`[ ]`), "Action Items:" headings, TODO markers, or `@name` mentions in your Granola notes |
| Wrong meeting date shown | Timestamp missing from document title | Ensure Zapier maps the full Granola note title (including the date/time suffix) as the Google Doc name |
| Action items not filtered to you | `USER_DISPLAY_NAME` not set or name variants don't match | Add all your name variants (first name, full name, username) comma-separated |
| Notes from old meetings showing up | Documents modified recently | The tool looks at documents modified in the last ~3 weeks; re-editing an old doc can resurface it |
