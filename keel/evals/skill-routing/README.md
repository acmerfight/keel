# Skill routing eval

This suite measures model-selected Skill routing independently from explicit
invocation. Each `task.json` keeps its `skillRouting` gold outside the copied
trial workspace. Task prompts use ordinary user language and must not mention
Skills or an invocation syntax. Trial workspace paths are opaque, so neither a
task id nor its expected activation is visible to the provider. Eval child
homes, configured roots, and transcript filenames are isolated as well.

Run three or more trials before making routing-quality claims:

```bash
keel eval --suite evals/skill-routing --trials 3 --out /tmp/skill-routing.jsonl
```
