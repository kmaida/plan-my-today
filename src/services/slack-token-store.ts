import fs from "node:fs/promises";
import path from "node:path";

export interface SlackTokenData {
  access_token: string;
  team_id: string;
  team_name: string;
  user_id: string;
  created_at: string;
}

const TOKEN_FILE_PATH = path.join(process.cwd(), "data", "slack-tokens.json");

// Ensure data directory exists
async function ensureDataDir() {
  const dir = path.dirname(TOKEN_FILE_PATH);
  await fs.mkdir(dir, { recursive: true });
}

export async function saveToken(userId: string, tokenData: SlackTokenData): Promise<void> {
  await ensureDataDir();
  const data = await readTokenFile();
  data.tokens[userId] = tokenData;
  await fs.writeFile(TOKEN_FILE_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export async function getToken(userId: string): Promise<SlackTokenData | null> {
  const data = await readTokenFile();
  return data.tokens[userId] || null;
}

export async function deleteToken(userId: string): Promise<void> {
  const data = await readTokenFile();
  delete data.tokens[userId];
  await fs.writeFile(TOKEN_FILE_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export async function hasToken(userId: string): Promise<boolean> {
  const token = await getToken(userId);
  return token !== null;
}

async function readTokenFile(): Promise<{ tokens: Record<string, SlackTokenData> }> {
  try {
    const content = await fs.readFile(TOKEN_FILE_PATH, "utf-8");
    return JSON.parse(content);
  } catch {
    return { tokens: {} };
  }
}
