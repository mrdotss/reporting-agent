"""The ONLY package in this runtime that may import an Azure SDK (Req 18.5, 18.7).

Filled by the Azure collector tasks. Keeping the SDK imports here is what lets
`collect/` and `storage/` be unit-tested without a subscription, and a static guard
fails the suite if a module outside this package imports a name beginning with
`azure`.
"""
