# Project memory index

Decisions and facts that are not derivable from the code or the git history. One file per fact.
Update the relevant file rather than adding a duplicate.

- [Auto IP requirement](auto-ip-requirement.md) - why nothing may hard-code a host address
- [Port allocation](port-allocation.md) - the ranges, who holds what, why 5545
- [Contracts as single source of truth](contracts-single-source.md) - why numbers live in JSON
- [Three scoring models](three-scoring-models.md) - they share variables and disagree on purpose
- [Reducer semantics](reducer-semantics.md) - min for vertical velocity, max for the rest
- [Slope is computed at 5km](slope-is-computed-at-5km.md) - not from the native DEM, and it changes every mountain score
- [Legacy precip at lead zero](legacy-precip-lead-zero.md) - hotspot and susceptibility rain conditions cannot fire at lead 0
- [Join key discipline](join-key-discipline.md) - join on district_code; district_name is unique only within a province
- [Admin layer defects](admin-layer-defects.md) - what was wrong in the delivered shapefiles and how each is handled
- [Payload size history](payload-size-history.md) - the 175 MB and 190 MB failures being designed out
- [Frontend toolchain](frontend-toolchain.md) - Tailwind 4, Vite, react-icons, no Lucide
- [No authenticated sources](no-authenticated-sources.md) - no keys or tokens, Earth Engine and GeoServer both ruled out
- [Data source status](data-source-status.md) - what is wired, what is still pending
- [Self-contained project](self-contained-project.md) - no context from other projects on this machine
- [No em-dashes](no-em-dashes.md) - writing style rule