# Workflows

`ci.yml` runs the repository quality gates, checks Drizzle migration metadata, and applies every
migration from zero against PostgreSQL 18. No workflow deploys from a failing main branch.
