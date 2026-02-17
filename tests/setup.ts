import path from "node:path";
import { config } from "dotenv";

// Isolate stores from the live app so tests don't affect real data
process.env.COMPLETIONS_FILE_PATH = path.join(process.cwd(), "data", "test-completed-actions.json");
process.env.OVERRIDES_FILE_PATH = path.join(process.cwd(), "data", "test-priority-overrides.json");
process.env.LLM_CACHE_FILE_PATH = path.join(process.cwd(), "data", "test-llm-extraction-cache.json");

config({ path: ".env.test" });

beforeAll(() => {
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "ERROR";
  process.env.ENABLE_OTEL = "false";
});

afterAll(() => {
  jest.clearAllTimers();
});