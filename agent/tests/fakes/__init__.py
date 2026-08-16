"""Fakes for the four Azure ports and for `ObjectStore`.

Filled by the collector tasks. The fakes replay recorded JSON response bodies —
including bodies carrying per-resource errors at HTTP 200, `skip_token` pages, quota
headers, `Retry-After` on 429, an oversized-response rejection and a DNS resolution
failure for one location.

The recordings themselves live in `tests/fixtures/`, whose loader owns the convention every
fake here replays: one JSON file per response, holding `status`, `headers` and `body`
together, because several of the behaviours being pinned down live in the envelope rather
than in the body.

Already present:

* :mod:`fakes.azure_clients` — a shared construction log plus stand-ins for
  `ClientSecretCredential` and for an Azure client, which is what makes "one credential,
  constructed before the first client" (Req 19.3) an ordered, countable fact.
* :mod:`fakes.azure_ports` — scripted fakes for the four ports declared in
  `reporting_agent.azure.ports` (`InventoryPort`, `SkuPort`, `DefinitionsPort`,
  `MetricsPort`), each replaying a sequence of `RawHttpResponse` objects built from the
  recordings in `tests/fixtures/azure/`.
* :mod:`fakes.object_store` — `InMemoryObjectStore`, an in-memory `ObjectStore`
  implementation that reproduces the one behaviour application code depends on the
  service for: a conditional put refusing a key that already holds an object
  (Req 34.9).
"""
