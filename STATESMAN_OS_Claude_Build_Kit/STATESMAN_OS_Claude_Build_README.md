# STATESMAN OS — Claude Code Build Kit

## Contents
- `STATESMAN_OS_PRD_v1_0.md` — authoritative product requirements, acceptance conditions, and safety boundaries.
- `STATESMAN_OS_Claude_Superpowers_Master_Prompt.md` — full build director/master prompt for Claude Code with the Superpowers workflow.

## Start
1. Open your intended project repository in Claude Code.
2. Install/verify Superpowers for Claude Code, following its current official instructions: `/plugin install superpowers@claude-plugins-official`.
3. Copy `STATESMAN_OS_PRD_v1_0.md` into your repository as `docs/PRD.md` or otherwise provide Claude direct access.
4. Paste the entire contents of `STATESMAN_OS_Claude_Superpowers_Master_Prompt.md` into Claude Code.
5. Check the generated design, threat model, and P0 traceability before approving implementation. Never provide real credentials in the prompt itself; use environment variables/secret stores.

## Scope
Build only the P0 decision-training MVP. Do not deploy publicly without explicit authorization. Treat demo scenarios as fictional unless independently sourced and reviewed.
