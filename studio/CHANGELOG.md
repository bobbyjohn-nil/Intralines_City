# Changelog

Finished work lands in **Unreleased**. Versions are cut only when you say so — run `/ship <version>`.

Grouped as Added / Changed / Fixed, in player-facing language.

---

## Unreleased

<!-- The orchestrator appends verified, finished work here. -->

---

<!--
Cut versions look like this:

## 0.1.0 — 2026-08-10

### Added
- Double jump, with a 100ms coyote window off ledges.

### Fixed
- Enemies no longer freeze permanently after a parry.
-->

### Added
- Draw bus lines along real streets on Riverton, a procedural city planned around its river: uniform blocks, embankment roads, four bridges, a cross-city diagonal avenue and parks that interrupt the grid.
- Watch buses run the lines you draw, at three clock speeds, with the map tinting through day and night.
- Stops cost $4,000 each, refunded on undo or cancel; wages and overhead accrue continuously.
- The game works with the network unplugged after first load, and tells you when a new version is ready instead of reloading under you.

### Fixed
- Buses are visible. Seven verification passes and six separate causes: a fixed marker size, a missing outline, a mount-time zoom race, camouflage against the route line, a map letterboxed into a third of the window, and a marker floor sized against the wrong reference.
