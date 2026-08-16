"""The provider protocol (`base.py`) and the id -> factory registry (`registry.py`).

Every operation's input and output is built only from plain data — `str`, `bool`, `int`,
`Decimal`, `None`, `list`, `dict` — so no cloud SDK type crosses this boundary and
everything downstream is unit-testable without a subscription.
"""
