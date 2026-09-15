"""The `chat` command: answer questions over grounding the app authorized (ask-chat Req 1).

`chat` is the one model-facing command in this runtime, and the package is organized so
that what the model can *see* and what it can *say* are both decided outside the model:

- `payload.py` parses the closed payload the web app sends — the prompt, the history, and
  the reports, scans and report-request targets the app has already authorized.
- `grounding.py` turns those attachments into **facts**: ledger figures from verified
  reports, counts from saved scans. A report whose verification did not pass, or whose
  ledger no longer matches the digest its verification recorded, contributes nothing.
- `stream_filter.py` is the enforcement: a fact the model references becomes the verified
  string, a numeral it typed itself is withheld, and a report proposal survives only if it
  names a target the app offered.
- `session.py` runs one turn and yields the events.

The model call itself lives in `narrate/chat.py`, with the other model call sites, and it
carries **no tool list** — nothing here gives a model something to call.
"""
