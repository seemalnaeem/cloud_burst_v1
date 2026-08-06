---
name: no-em-dashes
description: No em-dashes in any content this project produces, including prose, comments, UI strings and log messages.
metadata:
  type: feedback
---

No em-dashes anywhere: docs, comments, docstrings, commits, UI copy, error messages, log lines.

**Why:** requested directly, along with keeping the writing humanized. An em-dash is one of the
clearest tells of machine-generated prose, and the request is that this project not read that way.

**How to apply:** use a comma, a colon, parentheses, or two sentences. The result almost always reads
better, because an em-dash usually covers for a clause that wanted to be its own sentence.

The root documents supplied by the owner contain em-dashes and are not rewritten. This applies to
content this project creates.

Related: [[self-contained-project]]