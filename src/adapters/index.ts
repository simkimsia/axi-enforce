import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { cursor } from "./cursor.js";
import { gemini, qwen } from "./gemini.js";
import { opencode } from "./opencode.js";
import type { Adapter } from "./types.js";

export const ADAPTERS: Record<string, Adapter> = { claude, codex, opencode, gemini, qwen, cursor };
