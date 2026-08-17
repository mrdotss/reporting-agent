"""The only two model call sites in the product.

`summary.py` writes the executive summary's prose; `review.py` reads finished prose back and
files advisory observations. That is the complete list, and it is a **directory** rather than
a convention so "where can a model be reached from" has a filesystem answer: the
Boundary_Guard asserts that no module outside this package imports a Bedrock client.

Nothing here returns, computes or transports a number. Both call sites receive `formatted`
strings the compiler already placed, never a raw series — so a model is never in a position
to average anything, and a numeral it invents anyway is caught by the masking pass and
withholds the report. There is no tool registry in this runtime, which is why Req 19.7's
enumeration test is an assertion over an empty set: the strongest form it can take.
"""
