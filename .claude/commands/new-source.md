---
description: Wire a newly supplied data source into the stack, following the right playbook end to end.
argument-hint: <path or URL to the source>
---

New data source: $ARGUMENTS

1. **Classify** it: vector, raster, tabular or external API. That picks the playbook
   ([vector](../playbooks/ingest-vector-source.md), [raster](../playbooks/ingest-raster-source.md),
   [external](../playbooks/wire-external-api.md)).

2. **Inspect before anything else.** `ogrinfo -al -so` or `gdalinfo -stats`, or a manual `curl`.
   Report CRS, feature or pixel count, exact field names with casing, and value ranges. Do not assume
   the file matches its name.

3. **Compare against the repository.** Check `shared/contracts/` for expected field names and band
   keys, and [LAYER_REQUIREMENTS.md](../../LAYER_REQUIREMENTS.md) for expected counts. Report any
   mismatch explicitly, especially in a join key (`Districts`, `province`, `TEHSIL`), because a
   rename breaks scoring silently.

4. **Say whether it should be processed.** Some sources in DATA_SOURCES.md belong to the system being
   replaced. Recommend with a reason rather than ingesting by default. Anything needing
   authentication is out; find an anonymous alternative.

5. **Follow the playbook** if it should be processed: register in `meta.sources`, stage, validate,
   promote, verify.

6. **Update** [data-source-status.md](../memory/data-source-status.md).

Stop and ask if the inspection turns up a feature count well off what is documented, an unfamiliar
CRS, or field names that do not match the join keys.