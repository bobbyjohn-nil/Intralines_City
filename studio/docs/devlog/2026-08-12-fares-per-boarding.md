# Fares are per boarding, not per trip

The game's manual charges fare and subsidy per boarding—every time a rider boards a bus. But it converts fare to perceived minutes per *trip*, not per boarding. This created an exploit: split one line into two and you collected double fare and double subsidy from the same rider at zero perceived cost. About $3.85 of free revenue per rider for a purely cosmetic edit—a dominant strategy the moment anyone noticed.

The exploit was found while writing the demand spec, not playing. An economics bug surfaced in the mathematics before playtest.

The fix is specced: the RAPTOR solver will accumulate `fareMin` per boarding, so a transfer trip pays and perceives two fares—reproducing what actually happens when an agency breaks a through-route and people stop riding.

Riverton is now planned instead of generated—uniform 140 m blocks, embankment roads, exactly four bridges instead of a crossing at every street, and a diagonal avenue 38% faster than the grid. A river you can cross anywhere is scenery; four crossings make it a constraint.

Buses are visible at every zoom—the marker's minimum size (18 px) is derived from the stop marker's maximum (6 px) by construction, not tuning, so it always reads bigger.

- Pack size was wrong by twenty—LA is 0.5 MB gzipped, not blown the budget; tiling is not needed.
- Offline verified against a real network cut in the browser, not a registration check.

**Next:** Depot zones for Riverton; hoist stops out of Line.
