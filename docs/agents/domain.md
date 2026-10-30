# Domain Docs

How engineering skills should consume this repository's domain documentation.

## Before exploring

Read:

- `CONTEXT.md` at the repository root, if it exists
- Relevant ADRs under `docs/adr/`, if they exist

If these files do not exist, proceed silently. Domain documentation is created lazily when terminology or architectural decisions are resolved.

## Layout

This repository uses the single-context layout:

```
/
├── CONTEXT.md
├── docs/
│   └── adr/
└── src/
```

## Use the glossary's vocabulary

When output names a domain concept, use the term defined in `CONTEXT.md`. Do not drift to synonyms the glossary explicitly avoids.

If a necessary concept is absent, reconsider whether new terminology is needed or note the gap for domain modelling.

## Flag ADR conflicts

If proposed work contradicts an existing ADR, surface the conflict explicitly rather than silently overriding the decision.
