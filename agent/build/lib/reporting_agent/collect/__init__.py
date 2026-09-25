"""The pure collection pipeline: accumulate, sketch, bucket, archive, snapshot, log.

Filled by the collector tasks. Nothing here imports an Azure SDK; the pipeline sees
the provider protocol and plain data only.
"""
