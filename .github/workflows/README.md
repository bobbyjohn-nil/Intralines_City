# CI

`ci.yml` runs on every push and on pull requests targeting `main`. It enforces: the project
typechecks (`tsc -b`), the full test suite passes (`vitest run`), and the production build
succeeds and generates the service worker (`npm run build`). It also prints the gzipped size of
the built `dist/` output so a bundle-size regression is visible before it ships.

Before pushing, run the same three checks locally: `npx tsc -b`, `npx vitest run`, `npm run build`.
