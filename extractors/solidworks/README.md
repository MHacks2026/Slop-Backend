# SOLIDWORKS extractor

Reads a SOLIDWORKS part over the SOLIDWORKS API and writes it as design-intent IR (`packages/ir`), the input of the Onshape builder (`packages/onshape`). This is the "extraction agent" of the architecture doc (§3, §11): SOLIDWORKS stays the source of truth, nothing is parsed from the `.SLDPRT` file itself, and every value comes from the API.

It runs out of process against SOLIDWORKS on Windows. It attaches to the SOLIDWORKS you have open, or, when none is running, starts one in the background with no window and closes it when done.

## What you get

For `plate.SLDPRT` it writes two files next to the part, or into `--out`:

| File | Contents |
|---|---|
| `plate.ir.json` | The IR document: parameters (global variables), sketches with entities, relations and dimensions, features, topological references, per-feature evidence and Level 3 behaviour evidence. Validates against `packages/ir/schema/ir.schema.json`. |
| `plate.extract.json` | What happened to every tree node: `mapped` (with its IR id), `unsupported` (with the reason), `skipped`, `error`. Also every warning, the raw equation table, units and timings. Nothing is dropped without an entry here. |

Each IR feature also keeps the raw SOLIDWORKS feature data in `ext.sw.data`, including options the IR does not model.

## Requirements

- Windows 10 or 11 with SOLIDWORKS installed and licensed. Built against the 2024 SP1 API; runs on 2024 and later, and on older releases for every call that existed then.
- .NET Framework 4.8 (already part of Windows 10 and 11).
- To build: the .NET SDK (8 or later) on any OS. `dotnet build` works on macOS and Linux too, but the exe only runs on Windows.

## Build

```bash
dotnet build extractors/solidworks -c Release
```

The output is `extractors/solidworks/bin/Release/net48/`. Copy that whole folder (the exe plus the four `SolidWorks.Interop.*.dll` files) to the Windows machine, or build there.

## Run

```bash
SlopExtractor.exe extract C:\parts\plate.SLDPRT
```

```bash
SlopExtractor.exe extract --active
```

```bash
SlopExtractor.exe watch C:\parts --new-instance
```

- `extract <files or folders>` opens each part read-only, extracts it, and closes it. Parts you already have open are used as they are, and left open.
- `extract --active` extracts the part in front of you in SOLIDWORKS, saved or not.
- `watch <folder or part>` stays running and re-extracts each part a few seconds after you save it. With `--new-instance` it uses its own background SOLIDWORKS, so extraction never touches the session you are working in.
- `info` shows which SOLIDWORKS it would talk to and the open documents.

Options: `--out <dir>`, `--behavior <n>`, `--no-evidence`, `--pid <n>`, `--new-instance`, `--visible`, `--keep-running`. Run `SlopExtractor.exe --help` for details.

Then validate the IR, and build it in Onshape. The Onshape CLI resolves paths from `packages/onshape`, so give it an absolute path:

```bash
npm run validate -w @slop/ir -- path/to/plate.ir.json
```

```bash
npm run cli -w @slop/onshape -- build /absolute/path/to/plate.ir.json --out report.json
```

## How it reads a part

1. **Definitions**, at the end of the tree. It walks the FeatureManager tree in rollback order. Each sketch is extracted with:
   - its sketch-to-model transform;
   - lines, arcs, circles, ellipses and points;
   - relations, plus explicit coincidences where segments share an end point;
   - dimensions, attached to sketch geometry, the origin, or model edges.
   Each feature is dispatched on its feature-data interface, never on its type name, because `GetTypeName2` reports Instant3D extrudes as `ICE`.
2. **Rollback.** It moves the rollback bar after each solid feature and records evidence: body count, volume, area, centre of mass, bounding box, topology counts and face types. These are what `packages/onshape/src/validate.ts` checks each rebuilt feature against. In the same pass it re-measures references that were taken from the finished part, so a sketch face is described as it was before the next cut put a hole in it.
3. **Behaviour.** It changes up to 10 driving sketch dimensions by +10%, rebuilds, records the evidence, and restores each value (Level 3, §9). This is off for `--active` and `watch`, which work on documents you may have open; turn it on with `--behavior <n>`.

The document is left as it was found: rollback bar position, dimension values, nothing saved.

Each topological reference carries:
- `createdBy`: the feature that created the entity. The Onshape executor scopes its search by it.
- a semantic `role`, such as `capEnd`, `sideWall:l2` or `edge:sideWall:c1|capEnd:f2`.
- the SOLIDWORKS persistent id.
- a signature measured the way `resolver.ts` scores it: outward plane normal and offset, exact face centroid, arc-length midpoint (never for closed circles, whose start point is kernel-specific).
- a probe point.

## What is carried

| SOLIDWORKS | IR | Not carried (reported as unsupported) |
|---|---|---|
| 2D sketch | `sketch` | 3D sketches; splines, parabolas, text, partial ellipses (left out of the sketch, with a note) |
| Boss/Cut-Extrude | `extrude` | thin features, start offsets, "flip side to cut", up to body/selection |
| Revolve, Cut-Revolve | `revolve` | thin, mid-plane and two-direction (unless 360°), reference-axis axes |
| Fillet (constant radius) | `fillet` | variable, face, full round, asymmetric, conic; several radii in one fillet |
| Chamfer | `chamfer` | vertex chamfers |
| Hole Wizard (simple, counterbore, countersink, tapped as tap drill) | `hole` | tapered, counterdrilled, slots, extra near/far countersinks |
| Shell | `shell` | multi-thickness |
| Linear / circular pattern of features | `linearPattern`, `circularPattern` | body, face and vary-sketch patterns, up-to-reference spacing, symmetric/second direction (circular) |
| Mirror of features | `mirror` | face and body mirrors |
| Reference plane (offset, coincident, mid, angle) | `plane` | other constraint combinations |
| Global variables, equations | `parameters`, `Quantity.expr` / `parameter` | equations on suppression states |
| Custom properties, material | `customProperties` | |

Configurations, assemblies and multibody parts are out of the MVP (architecture doc §14); the active configuration is what gets extracted.

## Unverified until the first run against real SOLIDWORKS

These were taken from the API docs or are conventions, and could not be confirmed without a SOLIDWORKS seat. Each is marked `UNVERIFIED` in the code, and the per-feature checks on the Onshape side will catch a wrong one.

- **Cut direction.** A cut is assumed to go against the sketch normal unless reversed. In practice the direction is measured from the feature's own faces and the convention is only a fallback. Any disagreement is reported as a warning, which will confirm or refute the convention.
- **Arc direction.** It is decided from each arc's length, which does not depend on conventions. `GetRotationDir` is only used for semicircles, and disagreements are reported.
- **Mid-plane depth and offset-from-surface.** Mid-plane depth is taken as the total depth, and the offset as the reported depth.
- **Hole Wizard sizes.** Which diameter and depth properties apply per hole type; the first one set is used.
- **Patterns.** A circular pattern with equal spacing is taken to report the total angle; the index base of skipped instances is unverified.
- **Reference planes.** The flip flag of offset planes.

## Development

```bash
dotnet test extractors/solidworks/tests
```

The tests cover the SOLIDWORKS-independent code in `src/Core` (JSON writer, number cleaning, units, equation parsing, transforms, arc direction) and run on any OS. The interop assemblies come from the `Visiativ.SOLIDWORKS.Interop` NuGet package (SOLIDWORKS 2024 SP1, the same files as a SOLIDWORKS install's `api\redist`), so the compiler checks every API call even without SOLIDWORKS installed.

| Path | Role |
|---|---|
| `src/Program.cs` | CLI: `extract`, `watch`, `info` |
| `src/Session/` | Attaching to or starting SOLIDWORKS (ROT lookup by process id), COM retry filter, opening parts read-only |
| `src/Extract/PartExtractor.cs` | The three passes, tree walk, IR and report assembly |
| `src/Extract/SketchReader.cs` | Sketch entities, relations, dimensions |
| `src/Extract/FeatureReaders.cs` | One reader per feature type |
| `src/Extract/Topology.cs` | Topological references: createdBy, role, signature, re-measuring |
| `src/Extract/Evidence.cs` | Level 1 evidence and Level 3 perturbation |
| `src/Extract/Parameters.cs` | Global variables and equations |
| `src/Core/` | Pure helpers shared with the tests |
