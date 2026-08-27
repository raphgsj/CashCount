# Analytics package

`@cashcount/analytics` owns deterministic, read-only financial analytics over PostgreSQL canonical
views. Every query requires an explicit `workspaceId`, uses exact PostgreSQL numeric arithmetic,
and returns decimal strings without combining currencies.

PF-064 provides spending and deposit-account cash-flow summaries with separate posted and optional
pending buckets, bounded filters and time series, effective user overrides, policy version,
freshness, and structured data-quality warnings. Its accounting rules are documented in
`docs/accounting-policy.md`.

PF-065 adds exact net-spending period comparisons for calculated previous periods/months/years and
custom ranges. Full-period and same-elapsed-day comparisons remain separate by currency/status,
return null percentages for a zero comparison baseline, and expose bounded category changes. Later
Phase 6 analytics remain outside this package boundary until their tickets are implemented.
