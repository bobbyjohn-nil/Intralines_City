# First playable slice

The ledger stranded a cent a day. Office overhead is $250/day, so a one-minute tick bills $250/1440 — and 1,440 of those banked $249.99, not $250.00. Each tick rounded its own fractional remainder away, and the shortfall never came back. Rewrote it to compute the cumulative total owed from scratch at both ends of every tick and bank the difference, so each side rounds independently. Drift across 10,000 ticks is now exactly zero cents.

That's the kind of bug that surfaces six months later as "my money is slightly wrong and I can't say why."

Two more only showed up by actually playing. The page could scroll out of place — the browser's default 8px body margin made it 16px taller than the viewport, so a wheel scroll over the top bar slid the whole app downward. And zoom-about-cursor was off by 624 pixels, because longitude foreshortening was recomputed from the live centre latitude every frame; pinning it at construction fixed it and made the transform exactly affine.

Otherwise: you can draw a line along real streets, watch cost accumulate as you place stops, and watch money drain. The map tints with the time of day, holding night from 20:00 to 04:00.

Buses are implemented and tested but not yet visible on the map. That's unresolved.

**Next:**
- Riders who decide whether the bus beats driving, based on your fare and frequency
- Saving, before the save surface gets any bigger
