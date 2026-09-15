"""Public list prices, looked up deterministically for the resources a chat is grounded in.

Nothing here is reachable by a model: prices are fetched **before** the model call, for the
VM sizes a verified snapshot names, and handed to the model as facts. There is no free-form
lookup, no credential, and no cloud SDK — the Azure Retail Prices API is public.
"""
