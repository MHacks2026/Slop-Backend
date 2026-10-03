# @slop/ir

The design-intent intermediate representation (IR) from section 5 of the architecture document. One Zod definition is the source of truth; everything else is derived from it:

| Artifact | Where | Consumer |
|---|---|---|
| Zod schema + TypeScript types | `src/schema/*.ts`, re-exported from `src/index.ts` | Builder, translator, orchestrator, Worker |
| JSON Schema (draft 2020-12) | `schema/ir.schema.json` (generated, checked in) | C# extractor (quicktype / NJsonSchema), LLM structured output, any non-TS tool |
| Canonical serialization + sha256 hashing | `src/canonical.ts` | Content-addressed IR store, diffs |
| Referential integrity checks | `src/validate.ts` | Extractor output validation, CI |
| Section 16 example plate | `src/fixtures/plate.ts` | Tests, Phase 0 round-trip target |

## Model

```
Document
├── source, units, properties
├── parameters[]          global variables and equations (expr + SI value)
├── configurations[]      overlays: parameter / dimension / suppression overrides
├── partStudios[]
│   ├── features[]        rollback order; discriminated on `op`
│   │   sketch | extrude | revolve | fillet | chamfer | hole | shell
│   │   linearPattern | circularPattern | mirror | plane | axis | other
│   ├── bodies[]
│   └── evidence?         per-feature mass properties, topology, B-rep blobs
└── assemblies[]          instances (absolute transforms) and mates
```

Rules that hold everywhere:

- **Values are SI.** Metres, radians, square and cubic metres. A `Quantity` keeps the source expression and display unit next to the SI value, so `"50 mm"` survives as text and `0.05` as a number.
- **References are objects, not ids.** A `Ref` is a datum, a feature output (sketch region, body, plane) or regenerated topology. A topo ref carries every resolver the matcher may use: the creating feature and semantic role, the source persistent id, a geometric signature, adjacency context, and a probe point.
- **Nothing is dropped.** Any feature or sketch entity outside the core vocabulary becomes `op: "other"` with its raw payload in `ext`. `ext` is never read by the core and is skipped by integrity checks.
- **Configurations are overlays.** The base model is extracted once; each configuration lists overrides.
- **Features only reference earlier features.** `checkIntegrity` enforces this, along with id uniqueness and every cross-reference resolving.

### Sketch argument syntax

Constraints and dimensions refer to geometry with short strings:

| Form | Meaning |
|---|---|
| `l1` | whole entity |
| `l1.start`, `l1.end`, `a1.center`, `l1.mid` | a point of an entity (validated per entity type) |
| `ORIGIN` | sketch origin |
| `ext:leftEdge` | an entry of the sketch's `externalRefs` map, i.e. a model edge, face or vertex |

### Semantic role conventions for topo refs

`cap:start`, `cap:end`, `side:<sketchEntityId>`, `created`, `between(<featureId>.<role>, <featureId>.<role>)`. These are free strings in 0.1.0; they become a typed union once Phase 0 shows which roles the Onshape builder can turn into queries.

## Hashing

`hashDocument` returns a Merkle tree of sha256 hashes over the intent layer: per feature, per part studio, per assembly, and for the document. It excludes evidence (regenerable), `source` (provenance of one extraction), the document `id`, and each feature's `fidelity` (translator output). Canonical form sorts keys, drops `undefined`, rounds numbers to 12 significant digits and folds `-0`. Hashes use Web Crypto, so the same code runs in Node and in a Cloudflare Worker.

## Commands

```sh
npm run typecheck -w packages/ir
npm test -w packages/ir
npm run gen:schema -w packages/ir     # regenerate schema/ir.schema.json after editing src/schema
```

A test fails if the checked-in JSON Schema is stale. For C# types on the extractor side, `npm run gen:csharp -w packages/ir` runs quicktype (install it globally first); the output path assumes an `extractor/` directory at the repo root.

## Versioning

`IR_VERSION` in `src/schema/primitives.ts` is a literal on every document. Bump it on breaking changes and add a migration in the store before accepting documents with the new version.
