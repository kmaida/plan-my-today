import path from "node:path";
import { config } from "dotenv";

// Isolate stores from the live app so tests don't affect real data, and from
// each other: jest runs suites in parallel workers, and two suites sharing one
// fixture file race (seen as flaky "Received: false" after markActionComplete).
const w = process.env.JEST_WORKER_ID ?? "0";
process.env.COMPLETIONS_FILE_PATH = path.join(process.cwd(), "data", `test-completed-actions.${w}.json`);
process.env.OVERRIDES_FILE_PATH = path.join(process.cwd(), "data", `test-priority-overrides.${w}.json`);
process.env.LLM_CACHE_FILE_PATH = path.join(process.cwd(), "data", `test-llm-extraction-cache.${w}.json`);

config({ path: ".env.test" });

beforeAll(() => {
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "ERROR";
  process.env.ENABLE_OTEL = "false";
});

afterAll(() => {
  jest.clearAllTimers();
});