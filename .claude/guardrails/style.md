# Style

Only what is specific to this project. Ordinary good practice is assumed.

## Writing

**No em-dashes.** Anywhere: prose, comments, commits, UI copy, errors, logs, docstrings. Use a comma,
a colon, parentheses, or two sentences.

Say what a thing does and why it is that way. Delete a comment that only restates the line below it.
Prefer the concrete: "districts and tehsils were 175 MB uncompressed" beats "payload size matters".

## Project naming

| Context | Convention |
|---|---|
| CSS custom properties | `--cb-*` |
| Docker services | `cbd-*` |
| Query parameters | `snake_case`, matching the Python side |
| API paths | lowercase, hyphenated, plural |

Domain terms keep their spelling: CARI, PWAT, TCWV, CAPE, IIOJK. Do not helpfully expand them.

## Per tier

**React**: fetching goes in a hook, never a component body. Stable ids as keys. One component per
file; past ~200 lines something wants extracting.

**Python**: Pydantic models for request and response shapes, not dicts. Raise a typed error from
`app/shared/errors.py`, never bare `Exception`. Docstrings say why; the signature says what.

**SQL**: every migration opens with what and why. Forward-only, numbered, never edited once applied.

**Tailwind**: colors from `--cb-*` tokens through the theme, no hex in components. Utilities first; a
custom class only when a pattern repeats three times.

## Errors

Code, human message, request id. Never swallow into a generic 500, never log a secret or connection
string. Write for whoever reads the log at 2 am:

Good: `District "Upper Kohistan" has no geometry in geo.districts, ingest may not have run.`
Bad: `Error occurred`

## Comments worth writing

The non-obvious: reducer choices, threshold origins, why ingest stages first, why `-s 111120` is on
the slope command. Anchor to the source when encoding a decision:

```python
# Precipitation is cumulative since init, so difference consecutive leads.
# DATA_SOURCES.md section 8.1.
```