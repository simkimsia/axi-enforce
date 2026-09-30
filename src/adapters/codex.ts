import { claude } from "./claude.js";
import type { Adapter } from "./types.js";

// Codex CLI (0.156+) PreToolUse hook, matcher "^Bash$". Same wire format as Claude Code:
// stdin tool_input.command; deny via hookSpecificOutput.permissionDecision (exit 2 + stderr also works).
export const codex: Adapter = { ...claude, name: "codex" };
