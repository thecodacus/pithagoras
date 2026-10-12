---
name: "skill-creator"
description: "Use when asked to create, write, author or add a new skill — or when you notice you have explained the same procedure more than once and it should be written down. Covers the SKILL.md format, frontmatter, supporting files and where to put it so it loads."
---

# Writing a skill

A skill is a folder with a `SKILL.md` in it. You are reading one now.

Skills exist so a procedure is written down once instead of re-derived every
time. If you have explained something twice, it belongs in a skill.

## Where it goes

In your own skills folder: your instructions name it, in the line that starts
"Your own skills are in". Everything there is loaded for every conversation
you have, from the next one on.

```bash
mkdir -p "<your skills folder>/<skill-name>"
```

Nowhere else. A skill under `$HOME/.pi/agent/skills`, or anywhere else you
might think of, is not loaded. If your instructions name no skills folder, you
do not write skills in this conversation: say what the skill would hold and
leave it to the person you work for.

The folder name is not what matters; the `name` in the frontmatter is. Keep
them the same anyway, or the next person to look will be confused.

## The minimum

```markdown
---
name: "cut-a-release"
description: "Use when cutting a release: bump the version, update the changelog, tag and push."
---

# Cut a release

1. …
```

That is a complete, working skill.

## Frontmatter

Only two fields matter, and one of them does all the work.

| Field | |
| --- | --- |
| `name` | Lowercase, hyphenated. Must be unique — a clash means one of them is dropped. |
| `description` | **When to use this skill.** |
| `disable-model-invocation` | Optional. `true` means it is only reachable as `/skill:name` and you will never pick it yourself. |

### Quote your values

```yaml
description: "Use when cutting a release: bump, tag, push."   # correct
description: Use when cutting a release: bump, tag, push.     # breaks
```

A description is a sentence and sentences contain colons. Unquoted, that is
invalid YAML and the whole skill is silently dropped. Always quote both fields.

For anything long, a block scalar also works:

```yaml
description: |-
  Use when the user asks about deployment. Covers the staging and production
  pipelines, rollback, and who to tell when it goes wrong.
```

### The description is the only part read up front

Every skill's description sits in your context; the body is loaded only when
you decide the skill applies. So the description must say **when to reach for
it**, not what it contains.

```
"Use when the user asks to cut a release, tag a version, or publish."   good
"Release management and versioning procedures."                          useless
```

Write it as a trigger. Include the words someone would actually say, including
synonyms — "deploy", "ship", "push to prod" may all mean the same request.

## The body

Written for you, not for a human reading documentation. Be direct.

- **Steps in order**, numbered, one action each.
- **Exact commands**, not descriptions of commands.
- **Say what to check** after a step that can fail quietly.
- **Say what not to do**, where there is a tempting wrong path.

Keep it short. A skill that runs to several pages is usually two skills, or a
skill plus a reference file.

## Supporting files

Anything else in the folder comes along with it. Nothing outside `SKILL.md` is
loaded automatically — you read it when you need it, which is the point: detail
stays out of context until it is wanted.

```
my-skill/
  SKILL.md              the procedure
  reference/
    api.md              detail too long for the body
    examples.md
  scripts/
    check.sh            something to run rather than re-type
  templates/
    config.example.yml  something to copy
```

Reference them by relative path and say when to open them:

```markdown
Read `reference/api.md` before touching the request builder — the pagination
rules are not obvious.

Run `scripts/check.sh` after the migration. It exits non-zero if a table is
missing.
```

A script you ship needs `chmod +x` and a shebang, and should say what it does
when run with no arguments.

## After writing one

Skills load when a conversation starts, so a new one is not visible in the
conversation that created it. Tell the person it is there from your next
conversation, and on your Skills tab now.

Then check your work:

```bash
cat "<your skills folder>/<name>/SKILL.md"
```

Confirm the frontmatter is quoted, the name is unique, and the description
reads as a trigger rather than a title.

## Editing and removing

Same folder. Rewrite `SKILL.md` to change it; delete the folder to remove it.
The person you work for sees what is there on your Skills tab, on your page in
the portal.

## Before you write

Two questions worth asking first, because a skill that exists is a skill that
loads for every session:

- **Is it reusable?** A one-off answer is not a skill.
- **Does one already cover this?** Check your skills folder first and
  extend rather than duplicate — two skills with overlapping descriptions means
  neither reliably wins.

More detail, when you need it:

- `reference/frontmatter.md` — every field, and the failure modes
- `reference/assets.md` — laying out scripts, references and templates
