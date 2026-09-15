"""The only three model call sites in the product.

`summary.py` writes the executive summary's prose; `review.py` reads finished prose back and
files advisory observations; `chat.py` answers a question in the `chat` command (ask-chat).
That is the complete list, and it is a **directory** rather than a convention so "where can a
model be reached from" has a filesystem answer: the Boundary_Guard asserts that no module
outside this package imports a Bedrock client.

Nothing here returns, computes or transports a number that reaches a document. The report
call sites receive `formatted` strings the compiler already placed, never a raw series — so a
model is never in a position to average anything, and a numeral it invents anyway is caught
by the masking pass and withholds the report. The chat call site writes no document at all,
and its every chunk is rewritten by `chat/stream_filter.py` before it is emitted. There is no
tool registry in this runtime, which is why Req 19.7's enumeration test is an assertion over
an empty set: the strongest form it can take.
"""
