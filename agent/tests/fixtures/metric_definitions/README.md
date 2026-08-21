# The Metric Definitions evidence

One recorded `MonitorManagementClient.metric_definitions.list` response per resource
type the Metric_Catalog declares (Req 2.1). This directory is the **evidence the whole
catalog rests on**: `catalog/evidence.py` compares every catalog entry against the
fixture for its resource type, and a metric name, unit or aggregation the fixture does
not report fails the suite and the image build (Req 2.2, 2.3, 2.4, 2.6).

A guessed metric name makes a metric permanently uncollectable with nothing failing at
run time, so accuracy here matters more than coverage. Every name is recorded as the
source's **"Name in REST API"** value and never as a portal display name — the two
differ by exactly the case, whitespace and separator substitutions the near-miss rule
rejects (Req 2.7).

## File naming

```
<resource type lower-cased, each "/" replaced with "__">.json
```

| Resource type | File |
|---|---|
| `Microsoft.Compute/virtualMachines` | `microsoft.compute__virtualmachines.json` |
| `Microsoft.Sql/servers/databases` | `microsoft.sql__servers__databases.json` |
| `Microsoft.Sql/managedInstances` | `microsoft.sql__managedinstances.json` |
| `Microsoft.DBforPostgreSQL/flexibleServers` | `microsoft.dbforpostgresql__flexibleservers.json` |
| `Microsoft.Storage/storageAccounts` | `microsoft.storage__storageaccounts.json` |
| `Microsoft.Compute/disks` | `microsoft.compute__disks.json` |
| `Microsoft.Web/sites` | `microsoft.web__sites.json` |

A resource type carries one or two `/` characters, which no filesystem accepts in a
path segment, so the separator has to be substituted. `__` rather than `_` or `-`
because a single underscore, a hyphen and a period all occur **inside** the segments
themselves (`Microsoft.Compute`, `flexibleServers`), so substituting one of those would
make two distinct types capable of colliding on one filename. Lower-cased because
Resource Graph lower-cases `type` in its response body and `LoadedCatalog.for_resource_type`
folds case to match, so the file name follows the same rule the lookup does.

The authoritative resource type is the one recorded **inside** the file, in
`provenance.resource_type`, in its documented casing. The file name is derived from it
and is not the source of truth for it.

## Shape

The recorded-response envelope of `tests/fixtures/__init__.py` — `comment`, `status`,
`headers`, `body` — plus a `provenance` object. `load_response` reads such a file
without change; `provenance` is an additional key it ignores.

```jsonc
{
  "comment": "why this fixture exists",
  "provenance": {
    "resource_type": "Microsoft.Compute/virtualMachines",
    "region": "southeastasia",
    "captured_at": "2026-08-20T17:19:36Z",   // UTC RFC 3339, `Z`, whole seconds (Req 2.5)
    "capture_method": "derived_from_documentation",
    "derived_from": ["…the sources, named…"],
    "aggregation_bases": { "<basis key>": "what that basis is" },
    "aggregation_basis_by_metric": { "<metric name>": "<basis key>" },
    "selection": "why this fixture carries a subset",
    "omitted_metrics": [{ "name": "…", "reason": "…" }],
    "omitted_fields": ["…and why each is absent"],
    "region_note": "…"
  },
  "status": 200,
  "headers": { "content-type": "application/json; charset=utf-8" },
  "body": {
    "value": [
      {
        "namespace": "Microsoft.Compute/virtualMachines",
        "name": { "value": "Percentage CPU" },
        "unit": "Percent",
        "supportedAggregationTypes": ["Average", "Minimum", "Maximum", "Total", "Count"],
        "metricAvailabilities": [{ "timeGrain": "PT1M" }],
        "dimensions": [{ "value": "Context" }]     // omitted where none is documented
      }
    ]
  }
}
```

`unit` is the **Metric Definitions API's** own vocabulary (`Percent`, `Bytes`,
`BytesPerSecond`, `CountPerSecond`, `Count`, `Seconds`), not `DECLARED_UNITS`. The two
are associated by the unit mapping `catalog/evidence.py` declares; comparing them as
equal strings would fail every correct catalog entry (Req 2.9).

## What is excluded, and asserted excluded

No subscription identifier, tenant identifier, fully qualified resource identifier or
credential value appears in any fixture (Req 2.5), and `catalog/evidence.py` asserts
that rather than trusting it (Req 2.11). Concretely, the API's `id` and `resourceId`
fields are **omitted**, because both are fully qualified resource ids carrying a
subscription id. A metric definition is identical across every resource of one type in
one region — that is the premise of the Definition_Probe's cache — so nothing about a
particular resource is evidence of anything.

## Derived from documentation, not captured from a subscription

No subscription was available when these were written, so each fixture records what it
was derived from rather than claiming a capture it did not make:
`capture_method` is `derived_from_documentation` and `derived_from` names the pages.

Two consequences, both recorded in every file:

- **The fixtures are subsets.** Each carries the utilization series this product
  collects, restricted to metrics whose unit the mapping covers. A subset **fails
  closed**: a catalog entry naming a metric the fixture does not carry is rejected, so
  an omission can block a correct entry but can never admit a wrong one.
  `omitted_metrics` names every candidate that was dropped and why.
- **Each supported-aggregation set carries a per-metric basis**, keyed into
  `aggregation_bases`. The source documents its `Aggregation` column as the *default*
  aggregation type, and publishes a multi-value set for many metrics and a single value
  for others — so "the documented value" and "the supported set" are not the same claim
  for every metric, and each metric records which one it rests on. The weakest basis,
  `compute_documented_default_widened_by_platform_store_model`, says so in its own text
  and names what would replace it.

Replacing a fixture with a live capture is the intended end state: keep the shape, set
`capture_method`, drop `aggregation_basis_by_metric` for the metrics the capture covers,
and strip `id` and `resourceId` before committing.
