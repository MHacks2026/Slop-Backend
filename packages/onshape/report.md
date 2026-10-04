# Migration report

- Document: https://cad.onshape.com/documents/ebf8d01f966d26d32419205a/w/88b7e868950f29ddfe71a82f/e/429fe899e45dda5bc5629cb8
- IR intent hash: `bc601fc2022ab9857dbafd4d84962efdf5bfa303fbd392667ecbc6aaea297296`
- Planner: rules
- Features: 5 built, 0 failed, 0 skipped
- Fidelity: exact 4, approximated 1
- Checks: 22 passed, 0 failed
- Enhancements (implied intent the source never encoded): 0
- Onshape API calls: 18

| # | Feature | Op | Rung | Status | Attempts | Onshape id | Checks |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Sketch1 | sketch | exact | built (OK) | 1 | FLjKaiZRs9rg0WU_0 |  |
| 2 | Boss-Extrude1 | extrude | exact | built (OK) | 1 | F90es0WfSX9ZOcJ_0 | 8/8 |
| 3 | Sketch2 | sketch | approximated | built (OK) | 1 | FopwH2JbdlivKDx_1 |  |
| 4 | Cut-Extrude1 | extrude | exact | built (OK) | 1 | FJ4UTqmOqGrr1Sd_1 | 7/7 |
| 5 | Fillet1 | fillet | exact | built (OK) | 1 | FMJ2jBz04FdA8g7_1 | 7/7 |

## Sketch1
- Intent: direct mapping of sketch "Sketch1"
- Ref `f1.sketchPlane`: {"kind":"datum","name":"FRONT"} -> JDC via datum

## Boss-Extrude1
- Intent: direct mapping of extrude "Boss-Extrude1"
- Ref `f2.entities`: {"kind":"sketchRegion","sketch":"f1"} -> FLjKaiZRs9rg0WU_0 via feature

## Sketch2
- Intent: direct mapping of sketch "Sketch2"
- Note: dimension D2@Sketch2 references model geometry; placed at fixed coordinates instead (locating dimensions to model edges not mapped yet)
- Note: dimension D3@Sketch2 references model geometry; placed at fixed coordinates instead (locating dimensions to model edges not mapped yet)
- Ref `f3.sketchPlane`: {"kind":"irRef","irFeature":"f3","path":"plane"} -> JHK via signature

## Cut-Extrude1
- Intent: direct mapping of extrude "Cut-Extrude1"
- Ref `f4.entities`: {"kind":"sketchRegion","sketch":"f3"} -> FopwH2JbdlivKDx_1 via feature

## Fillet1
- Intent: direct mapping of fillet "Fillet1"
- Ref `f5.entities`: {"kind":"irRef","irFeature":"f5","path":"edges[0]"} -> JLF via signature

## Behaviour tests (proposed)
- D1@Sketch1 → `55 mm`: model regenerates; dependent features keep their references; volumes match the source after the same change
- D2@Sketch1 → `33 mm`: model regenerates; dependent features keep their references; volumes match the source after the same change
- D1@Sketch2 → `5.5 mm`: model regenerates; dependent features keep their references; volumes match the source after the same change
- D2@Sketch2 → `27.5 mm`: model regenerates; dependent features keep their references; volumes match the source after the same change
- D3@Sketch2 → `16.5 mm`: model regenerates; dependent features keep their references; volumes match the source after the same change
