const GMAIL_API_BASE = "https://www.googleapis.com/gmail/v1";
const COMPLETE_LABEL_NAME = "Complete";

interface GmailLabel {
  id: string;
  name: string;
  type: string;
}

interface GmailLabelsResponse {
  labels: GmailLabel[];
}

/**
 * Gets or creates the "Complete" label in Gmail.
 * Returns the label ID.
 */
export async function getOrCreateCompleteLabel(accessToken: string): Promise<string> {
  // First, try to find existing label
  const listResponse = await fetch(`${GMAIL_API_BASE}/users/me/labels`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!listResponse.ok) {
    throw new Error(`Failed to list labels: ${listResponse.statusText}`);
  }

  const labelsData = (await listResponse.json()) as GmailLabelsResponse;
  const existingLabel = labelsData.labels.find(
    (label) => label.name === COMPLETE_LABEL_NAME
  );

  if (existingLabel) {
    return existingLabel.id;
  }

  // Create the label if it doesn't exist
  const createResponse = await fetch(`${GMAIL_API_BASE}/users/me/labels`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: COMPLETE_LABEL_NAME,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    }),
  });

  if (!createResponse.ok) {
    throw new Error(`Failed to create label: ${createResponse.statusText}`);
  }

  const newLabel = (await createResponse.json()) as GmailLabel;
  return newLabel.id;
}

/**
 * Adds a label to an email message.
 */
export async function addLabelToEmail(
  accessToken: string,
  messageId: string,
  labelId: string
): Promise<void> {
  const response = await fetch(
    `${GMAIL_API_BASE}/users/me/messages/${messageId}/modify`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        addLabelIds: [labelId],
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to add label to email: ${response.statusText}`);
  }
}

/**
 * Removes a label from an email message.
 */
export async function removeLabelFromEmail(
  accessToken: string,
  messageId: string,
  labelId: string
): Promise<void> {
  const response = await fetch(
    `${GMAIL_API_BASE}/users/me/messages/${messageId}/modify`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        removeLabelIds: [labelId],
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to remove label from email: ${response.statusText}`);
  }
}

/**
 * Marks an email as complete by adding the "Complete" label.
 */
export async function markEmailComplete(
  accessToken: string,
  messageId: string
): Promise<void> {
  const labelId = await getOrCreateCompleteLabel(accessToken);
  await addLabelToEmail(accessToken, messageId, labelId);
}

/**
 * Unmarks an email as complete by removing the "Complete" label.
 */
export async function unmarkEmailComplete(
  accessToken: string,
  messageId: string
): Promise<void> {
  const labelId = await getOrCreateCompleteLabel(accessToken);
  await removeLabelFromEmail(accessToken, messageId, labelId);
}
