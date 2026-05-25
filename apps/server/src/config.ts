import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });
dotenv.config();

export const config = {
  aiApiKey: process.env.AI_API_KEY || "",
  aiBaseUrl: process.env.AI_BASE_URL || "https://api.openai.com/v1",
  aiModel: process.env.AI_MODEL || "gpt-4.1-mini",
  stateFilePath: process.env.STATE_FILE_PATH || path.resolve(process.cwd(), "../../.mini-ai-web-editor/state.json"),
  serverPort: Number(process.env.SERVER_PORT || 3001)
};
