# shared/

Everything in [contracts/](contracts/) is read by all three tiers. Nothing here is executable.

## Why data and not code

JavaScript and Python cannot share a module. What they can share is data. So every number that both
tiers need, thresholds, palettes, class boundaries, band metadata, layer definitions, port
allocation and the forecast time grid, lives here as JSON, and each tier ships a thin loader:

- `backend/app/shared/contracts.py`
- `middleware/src/lib/contracts.js`
- `frontend/src/lib/contracts.js`

Read through the loader. It validates the shape and caches the parse. Reading the JSON directly at a
call site skips both.

## Files

| File | What it settles |
|---|---|
| `cari.json` | 13 variables, both threshold matrices, weights, matrix selection rule, 7 classes, the override |
| `hotspot.json` | the 13 boolean conditions and how they combine |
| `susceptibility.json` | the 13 stricter thresholds, the area fraction rule, 5 classes |
| `bands.json` | band keys, labels, units, display ranges, derived band formulas |
| `palettes.json` | continuous ramps, classed palettes, categorical maps, radar legend bins |
| `layers.json` | vector layer ids, tile functions, default paint, clickable fields |
| `ports.json` | the port allocation |
| `time.json` | lead grid, history window, cycle cadence, precipitation rate rule |

## The `$comment` convention

JSON has no comments, so keys beginning with `$` carry the explanation. Loaders strip them. They are
there because several of these values look wrong without context, particularly the places where the
hotspot mask and susceptibility use very different numbers for the same variable.

## Changing something here

A contract change affects every tier at once. It is never a quiet edit.

1. Say what is changing and why.
2. Edit the JSON.
3. Update loader validation if the shape changed.
4. Run contract tests in all three tiers.
5. Update the golden scoring tests in the same commit if a threshold moved.
6. Note the reasoning in `.claude/memory/` if it is not obvious from the diff.
