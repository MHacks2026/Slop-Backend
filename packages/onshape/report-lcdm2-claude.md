# Migration report

- Document: https://cad.onshape.com/documents/30ec15dba3662a21e78432f3/w/145d1bd39f70b691f78cf0e5/e/398c04b437e185af0fa06608
- IR intent hash: `509d0ecc4900cd108b082c7c8e92454602c9c98c87cd2e7d4273338969692345`
- Planner: claude (claude-opus-5-5)
- Features: 9 built, 0 failed, 0 skipped
- Fidelity: approximated 3, exact 5, composite 1
- Checks: 49 passed, 0 failed
- Enhancements (implied intent the source never encoded): 0
- Behaviour (Level 3): 2 passed, 4 failed, 10 unverified
- Onshape API calls: 165
- LLM: 19 calls, 176082 in / 8996 out

| # | Feature | Op | Rung | Status | Attempts | Onshape id | Checks |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Sketch2 | sketch | approximated | built (WARNING) | 1 | F2TTFxlRc4DCZFP_0 |  |
| 2 | Revolve1 | revolve | exact | built (OK) | 1 | FI1mFcYNz1JhcuQ_0 | 9/9 |
| 3 | Chamfer1 | chamfer | exact | built (OK) | 1 | FmseW7kOhiP1L07_1 | 10/10 |
| 4 | Sketch3 | sketch | exact | built (OK) | 1 | FEQrbed8LD02rog_1 |  |
| 5 | #8-32 Tapped Hole1 | hole | approximated (deviation 4.29e-4) | built (OK) | 1 | FMa4zAKETQbqjGD_1 | 4/10 |
| 6 | Sketch6 | sketch | exact | built (OK) | 1 | FBK1pwVp8wczX02_1 |  |
| 7 | 5/16 (0.3135) Diameter Hole1 | hole | composite | built (OK) | 1 | F0v0I7gAUIjDyMO_1 | 7/10 |
| 8 | Sketch9 | sketch | exact | built (OK) | 1 | Ffa5DOnfaFhMs8U_1 |  |
| 9 | #9 (0.196) Diameter Hole1 | hole | approximated (deviation 9.36e-4) | built (OK) | 1 | FdZFkxGBxjmiaCG_1 | 4/10 |

## Sketch2
- Intent: This copies the source sketch one-to-one on the TOP datum. It keeps all 8 profile lines, the midpoint point fixed to the origin, all 18 relations, and the 6 driving dimensions with their original inch values. The sketch was fully constrained in SolidWorks and nothing needs to be added, so the rung is exact.
- Note: Onshape regenerated the sketch with a WARNING: at least one constraint or dimension was not applied; the sketch may be under-defined
- Note: planner claimed rung "exact" but the executor realised "approximated"
- Ref `f1.sketchPlane`: {"kind":"datum","name":"TOP"} -> JCC via datum

## Revolve1
- Intent: The SolidWorks revolve is a one-direction 360° new-body revolve of the f1 sketch region about sketch line l1. This maps directly to an Onshape FULL revolve with NEW operation, using live sketch region and sketch-entity axis references.
- Ref `f2.entities`: {"kind":"sketchRegion","sketch":"f1"} -> F2TTFxlRc4DCZFP_0 via feature
- Ref `f2.axis`: {"kind":"sketchEntity","sketch":"f1","entity":"l1"} -> JFB via probe

## Chamfer1
- Intent: Direct mapping of a SolidWorks distance-angle chamfer to an Onshape offset-angle chamfer on the same four circular edges (resolved live from the IR refs), with the IR distance, angle, flip and tangent propagation.
- Ref `f3.entities`: {"kind":"irRef","irFeature":"f3","path":"edges[0]"} -> JHJ via signature (confidence 1.000, runner-up 0.000)
- Ref `f3.entities`: {"kind":"irRef","irFeature":"f3","path":"edges[1]"} -> JHN via signature (confidence 1.000, runner-up 0.000)
- Ref `f3.entities`: {"kind":"irRef","irFeature":"f3","path":"edges[2]"} -> JHR via signature (confidence 1.000, runner-up 0.000)
- Ref `f3.entities`: {"kind":"irRef","irFeature":"f3","path":"edges[3]"} -> JHB via signature (confidence 1.000, runner-up 0.000)

## Sketch3
- Intent: Source sketch is one point fixed at the origin on the f2 end face. The plane is resolved from the IR face reference, so it stays a live link. All geometry and relations are copied straight from the IR.
- Ref `f4.sketchPlane`: {"kind":"irRef","irFeature":"f4","path":"plane"} -> JIi via probe

## #8-32 Tapped Hole1
- Intent: The SolidWorks HoleWzd is a bottoming tapped hole with a countersink, built here from three steps. First, a sketch on the start face places a circle the size of the tap drill (Ø0.136 in), with its centre locked to the f4 point. Second, an extrude cuts that circle 0.47 in deep, in the opposite direction, into the material. Third, a 90° countersink to Ø0.214 in is the same as a 45° chamfer with equal offsets of (0.214−0.136)/2 in = 0.9906 mm on the hole's rim edge. The 118° drill point is left out (flat bottom), so this is tagged approximated. The threads are cosmetic in the source, so they are not modelled.
- Note: source: ends in a 118 deg drill point; tapped hole: written as its tap drill; threads are not modelled
- Ref `f5.sketch.sketchPlane`: {"kind":"irRef","irFeature":"f5","path":"startFace"} -> JIi via probe
- Ref `f5.sketch.constraint[0]`: {"kind":"irRef","irFeature":"f5.sketch","path":"constraints[0].args[1]"} -> IJ via signature
- Ref `f5.entities`: {"kind":"sketchRegion","sketch":"f5.sketch"} -> Fv4ioM0tGKM7GRK_1 via feature
- Ref `f5.csk.entities`: {"kind":"createdBy","feature":"f5","entity":"edge","where":{"type":"circle","radius":0.0017272,"near":[0.02870835,0,0]}} -> JOB via query
- Advisory volume: expected 0.000011075884385, got 0.000011079126513645965 (error 2.93e-4)
- Advisory area: expected 0.0036418563424, got 0.0036402946439491597 (error 4.29e-4)
- Advisory centerOfMass: expected (-0.00591850, 0.00000, 0.00000), got (-0.00591193, 1.12661e-35, -2.28221e-19) (error 6.56e-6)
- Advisory vertexCount: expected 1, got 0
- Advisory faceTypes.cone: expected 6, got 5
- Advisory faceTypes.plane: expected 4, got 5

## Sketch6
- Intent: Sketch6 holds a single point fixed to the sketch origin. It sits on the f2 planar face with normal +X at offset -0.02870835. The direct plan matches the IR exactly. The plane is resolved live from the IR face reference.
- Ref `f6.sketchPlane`: {"kind":"irRef","irFeature":"f6","path":"plane"} -> JIS via probe

## 5/16 (0.3135) Diameter Hole1
- Intent: There's no native hole wizard here, so I rebuilt it as a composite of three steps. First, a sketch on the start face from f2, with the circle centre tied live to the f6 point and a Ø0.3135 in dimension. Second, a 0.5 in blind cut extrude; the drill angle is 180°, so the bottom is flat. Third, the 90° near-side countersink, done as an equal-offset chamfer of (0.3635−0.3135)/2 = 0.025 in = 0.635 mm on the rim edge. This matches how f5 was built.
- Note: checked as a change relative to the preceding approximated feature
- Ref `f7.sketch.sketchPlane`: {"kind":"irRef","irFeature":"f7","path":"startFace"} -> JIS via probe
- Ref `f7.sketch.constraint[0]`: {"kind":"irRef","irFeature":"f7.sketch","path":"constraints[0].args[1]"} -> IQ via signature
- Ref `f7.entities`: {"kind":"sketchRegion","sketch":"f7.sketch"} -> F0vbgLM0Fs6UEtp_1 via feature
- Ref `f7.csk.entities`: {"kind":"createdBy","feature":"f7","entity":"edge","where":{"type":"circle","radius":0.00398145,"near":[-0.02870835,0,0]}} -> JVB via query
- Advisory vertexCount: expected 1, got 0
- Advisory faceTypes.cone: expected 7, got 6
- Advisory faceTypes.plane: expected 5, got 6

## Sketch9
- Intent: Sketch9 has one point tied to the sketch origin. It sits on the planar face from f7 (normal +X, offset -0.016). The direct mapping keeps the plane as a live irRef and keeps the coincident constraint, so the sketch stays fully constrained, as it was in the source.
- Ref `f8.sketchPlane`: {"kind":"irRef","irFeature":"f8","path":"plane"} -> JVG via probe

## #9 (0.196) Diameter Hole1
- Intent: Simple blind drill hole: sketch the Ø0.196 in circle on the f7 start face, centred on the f8 sketch point, then cut it 0.124 in deep into the material. The 118° drill point is left off, so the hole has a flat bottom and is marked approximated.
- Note: source: ends in a 118 deg drill point
- Note: checked as a change relative to the preceding approximated feature
- Ref `f9.sketch.sketchPlane`: {"kind":"irRef","irFeature":"f9","path":"startFace"} -> JVG via probe
- Ref `f9.sketch.constraint[0]`: {"kind":"irRef","irFeature":"f9.sketch","path":"constraints[0].args[1]"} -> IX via signature
- Ref `f9.entities`: {"kind":"sketchRegion","sketch":"f9.sketch"} -> F0TmruCkrVnyNd1_1 via feature
- Advisory volume: expected 0.000010370336565260012, got 0.000010380041256801238 (error 9.36e-4)
- Advisory area: expected 0.004001723270607018, got 0.003998479639134962 (error 8.11e-4)
- Advisory centerOfMass: expected (-0.00484083, 1.51902e-35, -2.43028e-19), got (-0.00484795, 7.86961e-21, -2.45364e-19) (error 7.12e-6)
- Advisory vertexCount: expected 2, got 0
- Advisory faceTypes.cone: expected 8, got 6
- Advisory faceTypes.plane: expected 5, got 7

## Behaviour tests (Level 3)
Each driving dimension is changed in Onshape, the model regenerated and measured, then the change is reverted and the nominal model re-measured.
- FAILED D1@Sketch2 → `2.48655 in` (against source evidence): 6/10 checks; restored
  - FAILED centerOfMass: expected (-0.00683645, 7.86961e-21, -2.45364e-19), got (-0.00396493, 9.00137e-21, -2.34507e-19) (error 2.87e-3)
  - advisory vertexCount: expected 2, got 0
  - advisory faceTypes.cone: expected 8, got 6
  - advisory faceTypes.plane: expected 5, got 7
  - expectation: measured in SOLIDWORKS: D1@Sketch2 2.2605 in -> 2.48655 in rebuilds with volume +2.68%
- FAILED D2@Sketch2 → `0.34375 in` (against source evidence): 4/10 checks; restored
  - FAILED volume: expected 0.000012033889026401238, got 0.000012033927848922185 (error 3.23e-6)
  - FAILED area: expected 0.004290160562384961, got 0.004289834316643452 (error 7.60e-5)
  - FAILED centerOfMass: expected (-0.00558359, 7.86961e-21, -2.45364e-19), got (-0.00558263, 4.28791e-12, 0.000847649) (error 8.48e-4)
  - advisory edgeCount: expected 18, got 19
  - advisory faceTypes.cone: expected 8, got 6
  - advisory faceTypes.plane: expected 5, got 7
  - expectation: measured in SOLIDWORKS: D2@Sketch2 0.3125 in -> 0.34375 in rebuilds with volume +15.953%
- FAILED D3@Sketch2 → `0.9625 in` (against source evidence): 6/10 checks; restored
  - FAILED centerOfMass: expected (-0.00380251, 7.86961e-21, -2.45364e-19), got (-0.00602626, 7.62543e-21, -2.48828e-19) (error 2.22e-3)
  - advisory vertexCount: expected 2, got 0
  - advisory faceTypes.cone: expected 8, got 6
  - advisory faceTypes.plane: expected 5, got 7
  - expectation: measured in SOLIDWORKS: D3@Sketch2 0.875 in -> 0.9625 in rebuilds with volume +3.206%
- FAILED D4@Sketch2 → `0.20625 in` (against source evidence): 6/10 checks; restored
  - FAILED centerOfMass: expected (-0.00468836, 7.86961e-21, -2.45364e-19), got (-0.00468853, 7.55423e-21, 0.000512247) (error 5.12e-4)
  - advisory vertexCount: expected 2, got 0
  - advisory faceTypes.cone: expected 8, got 6
  - advisory faceTypes.plane: expected 5, got 7
  - expectation: measured in SOLIDWORKS: D4@Sketch2 0.1875 in -> 0.20625 in rebuilds with volume +4.18%
- PASSED D5@Sketch2 → `0.4862 in` (against source evidence): 7/10 checks; restored
  - advisory vertexCount: expected 2, got 0
  - advisory faceTypes.cone: expected 8, got 6
  - advisory faceTypes.plane: expected 5, got 7
  - expectation: measured in SOLIDWORKS: D5@Sketch2 0.442 in -> 0.4862 in rebuilds with volume +4.963%
- PASSED D6@Sketch2 → `0.16995 in` (against source evidence): 7/10 checks; restored
  - advisory vertexCount: expected 2, got 0
  - advisory faceTypes.cone: expected 8, got 6
  - advisory faceTypes.plane: expected 5, got 7
  - expectation: measured in SOLIDWORKS: D6@Sketch2 0.1545 in -> 0.16995 in rebuilds with volume +2.343%
- UNVERIFIED D1@Sketch2 → `2.5 in` (no source evidence for this change):; restored
  - expectation: Rebuild succeeds; overall length along D1 direction grows by ~0.2395 in; single solid body; volume increases monotonically; other dimensions unchanged.
- UNVERIFIED D1@Sketch2 → `2.0 in` (no source evidence for this change):; restored
  - expectation: Rebuild succeeds; overall length shrinks by ~0.2605 in; volume decreases; no self-intersection or sketch solve failure.
- UNVERIFIED D2@Sketch2 → `0.375 in` (no source evidence for this change):; restored
  - expectation: Rebuild succeeds; feature governed by D2 changes by 0.0625 in; profile remains closed; single body; bounding box changes only along the D2 direction.
- UNVERIFIED D3@Sketch2 → `1.0 in` (no source evidence for this change):; restored
  - expectation: Rebuild succeeds; extent governed by D3 grows by 0.125 in; volume increases; sketch remains fully constrained.
- UNVERIFIED D3@Sketch2 → `0.75 in` (no source evidence for this change):; restored
  - expectation: Rebuild succeeds; extent governed by D3 shrinks by 0.125 in; volume decreases; topology (face count) unchanged.
- UNVERIFIED D4@Sketch2 → `0.25 in` (no source evidence for this change):; restored
  - expectation: Rebuild succeeds; D4-driven feature changes by 0.0625 in; face count unchanged; single solid body.
- UNVERIFIED D5@Sketch2 → `0.5 in` (no source evidence for this change):; restored
  - expectation: Rebuild succeeds; D5-driven extent changes by 0.058 in; profile remains a single closed region; face count unchanged.
- UNVERIFIED D6@Sketch2 → `0.2 in` (no source evidence for this change):; restored
  - expectation: Rebuild succeeds; D6-driven extent changes by 0.0455 in; topology preserved; no zero-thickness or degenerate geometry.
- UNSUPPORTED D2@Sketch2,D4@Sketch2 → `0.125 in` (no source evidence for this change):; NOT restored
  - error: no Onshape sketch dimension found for "D2@Sketch2,D4@Sketch2" (global variables are not perturbed yet; a skipped dimension cannot be tested)
  - expectation: Rebuild succeeds with both reduced; single body; face count unchanged; volume changes consistent with smaller profile.
- UNSUPPORTED all → `Restore all dimensions to original values` (no source evidence for this change):; NOT restored
  - error: no Onshape sketch dimension found for "all" (global variables are not perturbed yet; a skipped dimension cannot be tested)
  - expectation: Model returns to original volume, bounding box and face count within 1e-6 relative tolerance.
