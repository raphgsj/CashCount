# Analytics package

`@cashcount/analytics` owns deterministic, read-only financial analytics over PostgreSQL canonical
views. Every query requires an explicit `workspaceId`, uses exact PostgreSQL numeric arithmetic,
and returns decimal strings without combining currencies.

PF-064 provides spending and deposit-account cash-flow summaries with separate posted and optional
pending buckets, bounded filters and time series, effective user overrides, policy version,
freshness, and structured data-quality warnings. Its accounting rules are documented in
`docs/accounting-policy.md`. Period comparison and later Phase 6 analytics remain outside this
package boundary until their tickets are implemented.
