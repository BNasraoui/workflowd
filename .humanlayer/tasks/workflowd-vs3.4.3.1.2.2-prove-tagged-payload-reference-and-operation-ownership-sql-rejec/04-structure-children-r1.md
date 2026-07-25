# Structure Children R1

Parent: `workflowd-vs3.4.3.1.2.2`

| Child ID | Title | Dependencies |
| --- | --- | --- |
| `workflowd-vs3.4.3.1.2.2.1` | Complete tagged graph and reject payload contradictions | `workflowd-vs3.4.3.1.2.1` |
| `workflowd-vs3.4.3.1.2.2.2` | Reject immutable-reference and diagnostic contradictions | `workflowd-vs3.4.3.1.2.2.1` |
| `workflowd-vs3.4.3.1.2.2.3` | Reject contradictory operation ownership and reconcile coverage | `workflowd-vs3.4.3.1.2.2.1` |

All three tasks inherit labels `cap-d3`, `qrspi`, `sqlite`, and `stage-runtime`. Each remains subject to its own Structure scope review before Plan; none is an implementation-ready leaf or an independently releasable outcome.
