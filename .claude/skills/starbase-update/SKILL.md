---
name: starbase-update
description: Update the live d1-server setup to the latest origin/main. The same procedure as /starbase-deploy, under the name the maintainer also uses. Run only when asked to update or deploy the live setup.
disable-model-invocation: true
argument-hint: [git ref to deploy, default origin/main]
---

# Update the live setup

This is the same job as `/starbase-deploy`. Read `.claude/skills/starbase-deploy/SKILL.md` and follow it exactly, passing on
the argument if one was given. Keep the procedure in that one file, so the two names can never drift apart.
