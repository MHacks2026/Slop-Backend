# Migration report

- Document: https://cad.onshape.com/documents/37f0f3f9833c309d863580fd/w/e3a66f378526fcc1d38cc0c0/e/196f3e7b2d21c49541f8bcae
- IR intent hash: `bc601fc2022ab9857dbafd4d84962efdf5bfa303fbd392667ecbc6aaea297296`
- Planner: claude (claude-opus-5-5)
- Features: 5 built, 0 failed, 0 skipped
- Fidelity: exact 5
- Checks: 22 passed, 0 failed
- Enhancements (implied intent the source never encoded): 0
- Onshape API calls: 20
- LLM: 10 calls, 73749 in / 3862 out

| # | Feature | Op | Rung | Status | Attempts | Onshape id | Checks |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Sketch1 | sketch | exact | built (OK) | 1 | FDcQH6JF4sydypD_0 |  |
| 2 | Boss-Extrude1 | extrude | exact | built (OK) | 1 | FwM67ZjJUG8Eton_0 | 8/8 |
| 3 | Sketch2 | sketch | exact | built (OK) | 1 | Fp0xRBHVEfQdunA_1 |  |
| 4 | Cut-Extrude1 | extrude | exact | built (OK) | 1 | FnyxZ1D1MpJvtX9_1 | 7/7 |
| 5 | Fillet1 | fillet | exact | built (OK) | 1 | FvVQ2ig2REUsxUt_1 | 7/7 |

## Sketch1
- Intent: Direct 1:1 mapping of the 50x30 mm rectangle on FRONT. The corner is anchored at the origin, and the IR's own constraints and driving dimensions are kept.
- Ref `f1.sketchPlane`: {"kind":"datum","name":"FRONT"} -> JDC via datum

## Boss-Extrude1
- Intent: Direct 1:1 mapping: new-body blind extrude of sketch f1's region, 10 mm depth from IR, no flip.
- Ref `f2.entities`: {"kind":"sketchRegion","sketch":"f1"} -> FDcQH6JF4sydypD_0 via feature

## Sketch2
- Intent: Direct mapping: the plane is the live capEnd face of f2 (z=0.01, normal +Z). There's one circle with the 5 mm diameter from the source, and its centre is placed by the two source distance dimensions to f2's edges (25 mm from the x=0 edge, 15 mm from the y=0 edge). No values or relations are invented, so the rung is exact.
- Note: dimension D2@Sketch2 references model geometry; placed at fixed coordinates instead (locating dimensions to model edges not mapped yet)
- Note: dimension D3@Sketch2 references model geometry; placed at fixed coordinates instead (locating dimensions to model edges not mapped yet)
- Ref `f3.sketchPlane`: {"kind":"irRef","irFeature":"f3","path":"plane"} -> JHK via signature

## Cut-Extrude1
- Intent: Direct mapping: SW Cut-Extrude Through All with flip maps to an Onshape extrude in REMOVE mode, THROUGH_ALL end, with oppositeDirection=true, profiled by the live f3 sketch region.
- Ref `f4.entities`: {"kind":"sketchRegion","sketch":"f3"} -> Fp0xRBHVEfQdunA_1 via feature

## Fillet1
- Intent: Direct 1:1 mapping of the SolidWorks fillet: single circular edge (r=2.5 mm, center [25,15,10] mm) created by f4 at the f2 cap, radius 2 mm from IR, tangent propagation on. Live irRef resolves via signature/probe.
- Ref `f5.entities`: {"kind":"irRef","irFeature":"f5","path":"edges[0]"} -> JLF via signature

## Behaviour tests (proposed)
- D1@Sketch1 → `D1@Sketch1 = 60 mm`: Rebuild succeeds; base profile length grows to 60 mm; Sketch2 feature (hole/boss) stays on its face at its dimensioned 25/15 mm location; volume increases.
- D2@Sketch1 → `D2@Sketch1 = 40 mm`: Rebuild succeeds; base profile width grows to 40 mm; Sketch2 feature keeps its 25/15 mm offsets; no references lost.
- D1@Sketch1 → `D1@Sketch1 = 40 mm`: Rebuild succeeds; Sketch2 feature at 25 mm offset (radius 5) still lies fully inside the 40 mm edge; volume decreases.
- D2@Sketch1 → `D2@Sketch1 = 25 mm`: Rebuild succeeds; Sketch2 feature at 15 mm offset with 5 mm size still lies inside the 25 mm width.
- D1@Sketch2 → `D1@Sketch2 = 8 mm`: Rebuild succeeds; only the Sketch2 feature size changes; its center stays at 25/15 mm; base block unchanged.
- D1@Sketch2 → `D1@Sketch2 = 3 mm`: Rebuild succeeds; Sketch2 feature shrinks; face count unchanged; position unchanged.
- D2@Sketch2 → `D2@Sketch2 = 20 mm`: Rebuild succeeds; Sketch2 feature translates 5 mm along the first axis; volume unchanged versus nominal.
- D3@Sketch2 → `D3@Sketch2 = 10 mm`: Rebuild succeeds; Sketch2 feature translates 5 mm along the second axis; volume unchanged versus nominal.
- D1@Sketch1,D2@Sketch1 → `D1@Sketch1 = 100 mm; D2@Sketch1 = 60 mm`: Rebuild succeeds; base scales; Sketch2 feature stays anchored at 25/15 mm from its reference edges (not centered), confirming the dimension scheme is live.
- D2@Sketch2,D3@Sketch2 → `D2@Sketch2 = 25 mm; D3@Sketch2 = 15 mm (restore nominal after perturbations)`: Model returns to its original volume and topology exactly, so the edits had no lasting effect.
