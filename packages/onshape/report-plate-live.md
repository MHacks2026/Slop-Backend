# Migration report

- Document: https://cad.onshape.com/documents/e7919b5b09e750b8f120ec63/w/d8b5b53f2f797d5d88dca7dc/e/309d06a53c9f71ce3e959f26
- IR intent hash: `6564034ca4813066a2f95d6bcab9a45dad80d1583dcbf9a34b968ed5e7a5282e`
- Planner: rules
- Features: 5 built, 0 failed, 0 skipped
- Fidelity: exact 5
- Checks: 23 passed, 0 failed
- Enhancements (implied intent the source never encoded): 0
- Behaviour (Level 3): 5 passed, 0 failed, 0 unverified
- Onshape API calls: 66

| # | Feature | Op | Rung | Status | Attempts | Onshape id | Checks |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Sketch1 | sketch | exact | built (OK) | 1 | Foo35Z61nPVGrWU_0 |  |
| 2 | Boss-Extrude1 | extrude | exact | built (OK) | 1 | F1TQyN9TboxGMGw_0 | 8/8 |
| 3 | Sketch2 | sketch | exact | built (OK) | 1 | FLF1508qPsrSiNt_1 |  |
| 4 | Cut-Extrude1 | extrude | exact | built (OK) | 1 | Fo8794cOjYJan67_1 | 7/7 |
| 5 | Fillet1 | fillet | exact | built (OK) | 1 | FTRwVXupkOM6oqC_1 | 8/8 |

## Sketch1
- Intent: direct mapping of sketch "Sketch1"
- Ref `f1.sketchPlane`: {"kind":"datum","name":"FRONT"} -> JDC via datum

## Boss-Extrude1
- Intent: direct mapping of extrude "Boss-Extrude1"
- Ref `f2.entities`: {"kind":"sketchRegion","sketch":"f1"} -> Foo35Z61nPVGrWU_0 via feature

## Sketch2
- Intent: direct mapping of sketch "Sketch2"
- Ref `f3.sketchPlane`: {"kind":"irRef","irFeature":"f3","path":"plane"} -> JHK via signature
- Ref `f3.D2@Sketch2`: {"kind":"irRef","irFeature":"f3","path":"dimensions[1].args[1]"} -> JHd via signature
- Ref `f3.D3@Sketch2`: {"kind":"irRef","irFeature":"f3","path":"dimensions[2].args[1]"} -> JHV via signature

## Cut-Extrude1
- Intent: direct mapping of extrude "Cut-Extrude1"
- Ref `f4.entities`: {"kind":"sketchRegion","sketch":"f3"} -> FLF1508qPsrSiNt_1 via feature

## Fillet1
- Intent: direct mapping of fillet "Fillet1"
- Ref `f5.entities`: {"kind":"irRef","irFeature":"f5","path":"edges[0]"} -> JLF via signature

## Behaviour tests (Level 3)
Each driving dimension is changed in Onshape, the model regenerated and measured, then the change is reverted and the nominal model re-measured.
- PASSED D1@Sketch1 → `55 mm` (against source evidence): 8/8 checks; restored
  - expectation: plate widens by 5 mm; the hole, dimensioned 25 mm from the right edge, moves with that edge (centre of mass x shifts); hole and fillet survive
- PASSED D2@Sketch1 → `33 mm` (against source evidence): 8/8 checks; restored
  - expectation: plate deepens by 3 mm; the hole stays 15 mm from the bottom edge
- PASSED D1@Sketch2 → `5.5 mm` (against source evidence): 8/8 checks; restored
  - expectation: hole widens in place; the fillet follows the new rim
- PASSED D2@Sketch2 → `27.5 mm` (against source evidence): 8/8 checks; restored
  - expectation: hole moves 2.5 mm further from the right edge; volume and area unchanged
- PASSED D3@Sketch2 → `16.5 mm` (against source evidence): 8/8 checks; restored
  - expectation: hole moves 1.5 mm further from the bottom edge; volume and area unchanged
