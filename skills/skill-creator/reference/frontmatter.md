# Frontmatter, in full

The block between the first two `---` lines. It is YAML, and it is the only
part of a skill parsed rather than read.

## Fields

### `name` (required)

```yaml
name: "cut-a-release"
```

Lowercase, hyphens, no spaces. This is what `/skill:<name>` uses.

Must be unique across every loaded skill — yours, ones from packages, ones
built into the portal. On a clash one is kept and the other reported as a
collision, and which one wins is not worth relying on.

### `description` (required)

```yaml
description: "Use when the user asks to cut a release, tag a version or publish a build."
```

The one field that decides whether the skill is ever used. See the guidance in
`SKILL.md` — write a trigger, not a title.

### `disable-model-invocation` (optional)

```yaml
disable-model-invocation: true
```

Removes the skill from the set you choose between. It stays reachable as
`/skill:<name>`, typed deliberately.

Worth it for something destructive, or for a procedure that should only run
when a human explicitly asks. The portal marks these "/skill only".

## Failure modes

### Unquoted colon

```yaml
description: Use when deploying: staging first, then production.
```

```
Nested mappings are not allowed in compact mappings at line 2, column 14
```

The skill is dropped entirely — not degraded, not partially loaded. It simply
does not exist as far as any session is concerned. Quote both values and this
cannot happen.

### Missing delimiters

The block must be the very first thing in the file, opened and closed by `---`
on their own lines. A blank line before the opener, or a missing closer, and
the file is read as ordinary markdown with no frontmatter — so no name, no
description, and it is skipped.

### A name that is not an identifier

Spaces, slashes and capitals cause trouble downstream. Stick to
`[a-z0-9-]`.

### Silence

A skill with broken frontmatter does not announce itself in conversation. Check
after writing:

```bash
head -5 "<your skills folder>/<name>/SKILL.md"
```

On your Skills tab in the portal, a skill whose frontmatter could not be read
shows under its folder's name with no description.

## A complete example

```markdown
---
name: "postmortem"
description: |-
  Use after an incident, when asked to write up what happened, do a
  postmortem, or record a retro. Covers the timeline, contributing factors
  and follow-up actions.
disable-model-invocation: false
---

# Write a postmortem

1. …
```
