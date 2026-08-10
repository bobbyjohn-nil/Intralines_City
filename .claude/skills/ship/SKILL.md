---
name: ship
description: Cut a version — stamp everything under Unreleased in CHANGELOG.md as a numbered release, optionally build and write a devlog. Use only when the user explicitly asks to ship, release, cut, tag, or version.
---

# Ship a version

Only ever run when the user explicitly asks. Never version on your own initiative.

1. **Read `CHANGELOG.md`.** If `## Unreleased` is empty, stop and say so — there is nothing to ship.

2. **Get the version.** Use the number the user gave. If they did not give one, show them what is under Unreleased and propose one with a one-line reason, then wait:
   - breaking change or a new act/chapter → major
   - new mechanics or content → minor
   - fixes and tuning only → patch

3. **Confirm the contents.** Show the user the grouped list exactly as it will be published. This is their last look — do not skip it.

4. **Stamp it.** Get the real date (`date +%Y-%m-%d`). Rename `## Unreleased` to `## <version> — <date>` and insert a fresh empty `## Unreleased` above it.

5. **Build.** Hand off to `build-engineer`: version stamped into the build, debug flags off, artifact verified to launch from a clean directory. Then `playtester` runs the built artifact, not the dev build.

6. **Write it up.** Hand the released section to `devlog-writer` for patch notes, and a devlog if the release is substantial.

7. **Tag**, if this is a git repo: `git tag v<version>`. Do not push, do not upload, do not publish — hand the user the commands and let them press the button.

Report: version, what is in it, where the artifact is, what `playtester` verified, and anything that shipped known-broken.
