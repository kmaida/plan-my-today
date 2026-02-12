import path from "node:path";
import { config } from "dotenv";

// Isolate the completion store from the live app so tests don't wipe real dismissals
process.env.COMPLETIONS_FILE_PATH = path.join(process.cwd(), "data", "test-completed-actions.json");

config({ path: ".env.test" });

beforeAll(() => {
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "ERROR";
  process.env.ENABLE_OTEL = "false";
});

afterAll(() => {
  jest.clearAllTimers();
});