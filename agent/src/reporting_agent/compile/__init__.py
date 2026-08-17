"""The compile stage: definition -> document AST -> figure ledger.

Nothing here calls Azure or a model. `definition.py` carries the block-type
vocabulary the `Template_Validator` (`app/lib/templates/blocks.ts`) and this
package's own validator (`Task 5.1`) both read. The rest of this package —
`ast.py`, `figures.py`, `format.py`, `scope.py`, `estimators.py` and
`blocks/` — is filled in by the compile-stage tasks that follow.
"""
