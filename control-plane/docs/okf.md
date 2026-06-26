---
type: Reference
title: OKF Bundle Notes
description: How NeurOn's docs use Open Knowledge Format conventions.
tags: [docs, okf, knowledge-bundle]
timestamp: 2026-06-25T00:00:00Z
---

# Purpose

This directory is an Open Knowledge Format bundle for NeurOn. OKF is a
human- and agent-friendly format based on markdown files with YAML frontmatter.
NeurOn uses it for design rationale, operational context, and implementation
knowledge that should survive the eventual split into a dedicated repository.

# Bundle Conventions

* `index.md` is the bundle entry point and progressive-disclosure listing.
* Every non-reserved concept document has YAML frontmatter with at least `type`.
* Concept documents use stable relative links where helpful.
* Body content stays structured with headings, lists, and code blocks.
* Unknown future frontmatter fields should be preserved.

# Scope

This bundle documents NeurOn. Runtime-specific GPU, model-download, and
llama.cpp tuning rationale belongs with the external runtime project that owns
those choices.

# Citations

[1] [Open Knowledge Format specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
