---
name: milweb-hq
description: Deprecated alias of the my-company-ai skill, kept temporarily for people who installed the project under its previous name (MilWeb HQ). Use when the person runs /milweb-hq or asks to install, open or update "MilWeb HQ".
---

# MilWeb HQ is now My Company AI

This command is a temporary compatibility alias. The project was renamed:

- Product: **My Company AI**
- Repository: https://github.com/rickjs2005/my-company-ai
- Skill and command: **`/my-company-ai`**

What to do:

1. Tell the person the project was renamed and that `/milweb-hq` will be removed in a future release.
2. If the skill `my-company-ai` is installed (`~/.claude/skills/my-company-ai/SKILL.md`), follow that skill.
3. If it is not, offer to install it: copy the folder `skills/my-company-ai` from the repository to
   `~/.claude/skills/my-company-ai`. Then follow it.

Existing installs keep working: the data folder (`%LOCALAPPDATA%\MilWebHQ`), the `MILWEB_HQ_*` variables and the
`start-hq.cmd` launcher did not change. An older clone can point at the new address with
`git remote set-url origin https://github.com/rickjs2005/my-company-ai.git`.
