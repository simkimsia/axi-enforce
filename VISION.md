# Vision

`axi-enforce` is a pre-command hook for coding agents that steers them from a plain vendor CLI (such as `gh`, `railway` or `wrangler`) to its AXI wrapper, and stops them from truncating axi output with `head`, `tail` or `cut`.
It is a guardrail against habit, not a sandbox.

## Scope

We accept changes that catch the habits agents actually show: a plain CLI call where an axi exists, or an axi piped into a truncating command.
Evidence that a habit is real is a command seen in an agent transcript, a hook log, or an issue that quotes one.
We accept changes that keep the escape hatch working: `AXI_GAP=<repo>#<n>` for owned axis, `AXI_BYPASS=1` for the rest, and `AXI_TRUNCATE=1` for the truncation guard, each logged.
We do not add checks for commands outside these two jobs, such as general shell linting or blocking other tools.

## Threat model

The agent being guarded is cooperative; it reaches for the plain CLI out of habit, not to get past the hook.
Adversarial evasion is out of scope: `eval`, aliases, shell functions, script files that call `gh` internally, and constructed command strings are allowed to get through.
A change that catches a new construct aligns when that construct was seen in real agent commands, and is optional otherwise.
A missed construct that no agent has been seen to write is a follow-up issue, not a defect in the change under review.
We do not grow the scanner in `src/parse.ts` into a full shell interpreter to close theoretical bypasses.

## Failure mode

The hook fails open: any error in the hook path allows the command and writes the error to stderr.
A change must never deny a command it should allow without printing the escape that lets the agent run it.
A change that makes the hook deny with no escape, hang, or block the shell on an error does not align, however rare the input.
A change that makes the hook throw on input it used to catch does not align either, because failing open then lets the command through.
Any other wrong allow is a missed catch and falls under the threat model, not under this rule.
