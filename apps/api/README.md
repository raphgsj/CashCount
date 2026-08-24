# API application

`@cashcount/api` currently exposes only `POST /webhooks/pluggy`. PF-040 authenticates a strict
`Authorization: Bearer <PLUGGY_WEBHOOK_SECRET>` header with fixed-length digest comparison, accepts
only `application/json`, and enforces a 256 KiB limit from both `Content-Length` and the received
stream.

The route validates the ten first-wave Item/transaction events documented by Pluggy, rejects all
payment event types, maps workspace scope only through stored Item/account identities, encrypts the
validated original payload with the active key, and transactionally inserts one `PROCESS_WEBHOOK`
job containing only the internal inbox ID. Unknown or ambiguous identities remain explicitly
`UNMAPPED` with a nullable-workspace repair job. Duplicate deliveries return the same `202` without
creating another row or job.

No provider client is a dependency of the API webhook route. Provider retrieval and event handling
remain later worker tickets; the ingestion response follows only the bounded database transaction.

Payload field requirements are based on the official
[Pluggy webhook guide](https://docs.pluggy.ai/docs/webhooks). Additive fields are retained in the
encrypted envelope but never treated as authoritative workspace or financial state.
