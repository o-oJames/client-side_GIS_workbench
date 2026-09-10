# geoprocessing_tool_tests

External test harness for the **Vector Tools** (geoprocessing) panel. Everything
here verifies the engines that live in `gis_workbench/src/utils/` — none of it
ships with the app.

It sits at the repo root, outside `gis_workbench/`, on purpose. `gis_workbench/`
is the front-end package: what is in it gets bundled, typechecked as app code and
read as app source. A Python script that shells out to QGIS, a 92 KB blob of
third-party-engine expectations, and the two suites that consume them are none of
those things. Keeping them here means `gis_workbench/src/` contains only
application code plus that code's own unit tests.

## Contents

| File | What it is |
| --- | --- |
| `geos-golden.py` | **The generator.** Asks a real GEOS for the answers the differential tests assert against. Needs a Python with `shapely`; it is never run at build or test time. |
| `geosGolden.json` | **GENERATED — committed, never hand-edited.** GEOS 3.14.1's verdicts on 17 validity cases, 12 overlay pairs × 4 operators, and 135 buffers. Regenerate with the script above. |
| `validity.geos.test.ts` | Check Validity + Make Valid, differentially against GEOS: verdict, reason class, error location, and Make Valid's part count and area. |
| `overlay.geos.test.ts` | Union / intersection / difference / symmetric difference on 12 geometry pairs, plus the buffer engine on 135 rows, against GEOS's areas. |

Both suites read `./geosGolden.json` and import the engine under test relatively:

```ts
import { unionGeometries } from '../gis_workbench/src/utils/overlay';
```

## Running them

They are part of the `gis_workbench` vitest project — not a second project, and
not something you have to remember to run separately:

```sh
cd gis_workbench
npm run test:run      # whole suite, these two files included
npm run test:geos     # just these two files
```

Two settings in `gis_workbench/vite.config.ts` make that work, and both are
commented there:

- `test.include` gains `'../geoprocessing_tool_tests/**/*.test.ts'`, so vitest
  discovers files outside its own root.
- `server.fs.allow` gains `'..'`, so Vite will transform them. `'..'` is the repo
  root, which is the scope Vite's default workspace search already resolves to.

`gis_workbench/tsconfig.json` includes this folder too, so `tsc --noEmit` — and
therefore `npm run build` — still typechecks these suites exactly as it did when
they lived under `src/utils/`. It also maps the bare specifier `vitest` back to
`gis_workbench/node_modules`, because TypeScript resolves upward from *this*
file's directory and there is no `node_modules` here. That mapping is
typecheck-only; Vite resolves it at run time on its own.

There is deliberately no `package.json` and no `node_modules` in this folder. It
borrows the app's, so there is nothing to install and no second dependency tree
to drift.

## Regenerating the goldens

Only needed when the case list in `geos-golden.py` changes, or when a rule in the
engine changes and you want to re-ask GEOS rather than trust the old answer.

```sh
/Applications/QGIS.app/Contents/MacOS/python geoprocessing_tool_tests/geos-golden.py
```

Any Python with `shapely` works. The QGIS one is used because its GEOS is the GEOS
QGIS's own tools run, so "matches GEOS" means "matches what a QGIS user sees".
The GEOS, shapely and Python versions are recorded in the JSON's `provenance`
block — "matches GEOS" is meaningless without saying *which* GEOS. A clean
regeneration on unchanged cases should be a **one-line diff** (the `generator`
path) or no diff at all; anything more means the engine's inputs or the case list
moved.

The script writes `geosGolden.json` beside itself and touches nothing else. In
particular it does not edit the test files: the `CASES` tables in
`validity.geos.test.ts` are hand-written prose about *why* each case exists, and
the numbers they are held to come from the JSON.

## What is deliberately NOT here

The engines' own unit and property suites stayed in `gis_workbench/src/utils/`,
next to the code they test, because they are ordinary app tests with no external
oracle and no generated data:

- `overlay.test.ts` — hand-built fixtures for the overlay kernel.
- `overlay.property.test.ts` — seeded fuzz + algebraic invariants (area
  conservation, inclusion–exclusion, idempotence, commutativity, and
  byte-identical output under any subject order).
- `buffer.test.ts` — the buffer engine's exact (piece-union) path.
- `geoprocessing.test.ts` — golden tests for every Vector Tools engine.
- `geoprocessing.realdata.test.ts` — the tools against the real datasets in
  `sample/`, including a checked-in QGIS 3.44.7 dissolve to diff against.

That last one is also an external-oracle suite, but its oracle is `sample/`,
which is git-ignored and resolved relative to `src/utils/`; every suite in it is
`describe.skipIf(!HAVE_SAMPLES)` so a fresh clone skips rather than fails. Moving
it would only move the dependency, not remove it.

**Nothing in here needs Python, QGIS or `sample/` to run.** The JSON is committed,
so the differential suites pass on a clean clone with nothing but `npm install`.
