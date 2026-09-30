---
applyTo: "**"
description: 当智能体准备运行任何命令、脚本或代码时，必须先向用户说明该进程的作用；若涉及有风险的操作，必须明确告知允许执行后可能产生的后果，并获得用户确认。
---

# Command Execution Disclosure

## Absolute Rule

Before executing **any** command, script, or code in the terminal, the agent MUST first output a disclosure block to the user. This is NOT optional and NOT a suggestion. Do NOT call any terminal tool before the disclosure is shown.

Exception: none. Even read-only commands (ls, cat, git status, pwd) require a one-line disclosure.

## Required Disclosure Format

For EVERY command, output first:

About to run: <full command>
Purpose: <one sentence>
Impact: <read-only / which files / which system>
Risk: No risk | Low | Medium | High

For Medium and High risk, additionally output:

Possible consequences: <worst case>
Reversible: <yes / no / partial>
Impact scope: <local / project / team / production>
Mitigation: <backup / dry-run / etc.>

Then stop and ask: "Allow execution? Reply 'allow' or request changes."

Do NOT execute Medium or High risk commands until the user replies with approval.

## Risk Levels

- No risk: read-only, no side effects (ls, cat, git status, pwd)
- Low: reversible, local (create file, install dependency, start local server)
- Medium: may affect others or data (modify config, push code, write DB)
- High: irreversible or broad (rm -rf, DROP TABLE, format, production deploy, privilege escalation, overwrite files)

## Hard Constraints

1. No silent execution. Every terminal tool call must be preceded by a disclosure block.
2. No hidden risk. Never downplay or omit known risks.
3. Medium and High risk require explicit user approval before execution.
4. No scope creep. Do not execute operations broader than disclosed.
5. When unsure, escalate the risk level and say so.
6. Report side effects immediately.
7. Decompose compound commands (pipes, &&, multi-step) and disclose each key step.

## Confirmation Keywords

Approval: allow / run / continue / confirm / yes
Rejection: no / cancel / change to ...
If no explicit approval is received, wait and do not execute.
