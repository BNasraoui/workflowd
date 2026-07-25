# Structure Child Creation Manifest

**Parent:** `workflowd-vs3.4.3.1`

**Source review:** `.humanlayer/tasks/workflowd-vs3.4.3.1-persist-reload-document-runtime-aggregates/04-structure-scope-review-r1.md`

| Child ID | Title | Direct dependencies |
| --- | --- | --- |
| `workflowd-vs3.4.3.1.1` | Install the strict inactive shared runtime layout | None |
| `workflowd-vs3.4.3.1.2` | Prove shared runtime SQL invariants and upgrade preservation | `workflowd-vs3.4.3.1.1` |
| `workflowd-vs3.4.3.1.3` | Define the strict document aggregate boundary | `workflowd-vs3.4.3.1.2` |
| `workflowd-vs3.4.3.1.4` | Persist one exact document aggregate atomically | `workflowd-vs3.4.3.1.3` |
| `workflowd-vs3.4.3.1.5` | Reload one valid document aggregate exactly | `workflowd-vs3.4.3.1.4` |
| `workflowd-vs3.4.3.1.6` | Diagnose document aggregate shape and identity contradictions | `workflowd-vs3.4.3.1.5` |
| `workflowd-vs3.4.3.1.7` | Diagnose document aggregate order and hash contradictions | `workflowd-vs3.4.3.1.6` |
| `workflowd-vs3.4.3.1.8` | Prove failed reads are contained and runtime stays inactive | `workflowd-vs3.4.3.1.7` |

All children are open priority-1 tasks under `workflowd-vs3.4.3.1`, inherit labels `cap-d3`, `qrspi`, `sqlite`, and `stage-runtime`, and require their own independent Structure scope review before Plan. None is declared implementation-ready.
