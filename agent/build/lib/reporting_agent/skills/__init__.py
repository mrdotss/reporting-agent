"""Agent skills: packaged knowledge the runtime can hand a model when it needs it.

Three sources, vendored under `vendor/` at pinned commits by `agent/dev/vendor_skills.py`
(licences beside them, provenance in `vendor/SOURCES.json`):

* **style** — `no-ai-slop` (MIT). Its word and pattern lists are appended to every
  narration prompt and to Ask's, with this product's figure rules taking precedence
  (`style.py`).
* **azure** — a curated set of Microsoft's Agent Skills (CC-BY-4.0): mostly indexes of
  learn.microsoft.com pages by topic.
* **aws** — a curated set of AWS's agent toolkit skills (Apache-2.0): guidance written
  inline, plus reference files.

Only Ask uses the Azure and AWS skills. A report's narrative may carry no number the
compiler did not place, and product knowledge is full of them, so letting it into a report
would withhold the report; in Ask an unverified number is removed or marked as an estimate
by the answer filter. `catalogue.py` loads them; `narrate/skills.py` lets a model choose
among them; `fetch.py` reads the documentation pages they point at.

This package imports nothing that reaches the network except `fetch.py`, which only the
chat session imports — the report and verification paths load `style.py` alone.
"""
