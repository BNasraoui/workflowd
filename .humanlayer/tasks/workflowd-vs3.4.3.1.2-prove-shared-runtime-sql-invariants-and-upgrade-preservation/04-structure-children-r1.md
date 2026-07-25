# Structure Children R1

Parent: `workflowd-vs3.4.3.1.2`

| Child ID | Title | Dependencies |
| --- | --- | --- |
| `workflowd-vs3.4.3.1.2.1` | Prove runtime identity-spine SQL rejection | `workflowd-vs3.4.3.1.1` |
| `workflowd-vs3.4.3.1.2.2` | Prove tagged payload, reference, and operation-ownership SQL rejection | `workflowd-vs3.4.3.1.2.1` |
| `workflowd-vs3.4.3.1.2.3` | Prove exact file-backed 0010 upgrade preservation | `workflowd-vs3.4.3.1.1` |

All three children require their own Structure scope review before Plan. The parent migration release gate remains atomic across all three outcomes.
