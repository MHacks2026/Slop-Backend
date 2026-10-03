/**
 * Onshape feature JSON ("BT" types). Names with numeric suffixes are the
 * serialized class ids Onshape uses; they are part of the wire format.
 *
 * Verified against the Onshape API guides: BTFeatureDefinitionCall-1406,
 * BTMSketch-151, BTMFeature-134, BTMParameterQuantity-147,
 * BTMParameterEnum-145, BTMParameterBoolean-144, BTMParameterQueryList-148,
 * BTMIndividualQuery-138, BTMIndividualSketchRegionQuery-140,
 * BTMSketchCurve-4, BTCurveGeometryCircle-115.
 *
 * UNVERIFIED (learn from `cli readback` of a UI-built model):
 * BTMSketchCurveSegment-155 / BTCurveGeometryLine-117, BTMSketchPoint-158,
 * BTMSketchConstraint-2 and its constraintType vocabulary,
 * BTMParameterString-149 for local sketch references.
 */

export interface BTParameterQuantity {
  btType: "BTMParameterQuantity-147";
  parameterId: string;
  expression: string;
  isInteger?: boolean;
}
export interface BTParameterEnum {
  btType: "BTMParameterEnum-145";
  parameterId: string;
  enumName: string;
  value: string;
}
export interface BTParameterBoolean {
  btType: "BTMParameterBoolean-144";
  parameterId: string;
  value: boolean;
}
export interface BTParameterString {
  btType: "BTMParameterString-149";
  parameterId: string;
  value: string;
}
export interface BTIndividualQuery {
  btType: "BTMIndividualQuery-138";
  deterministicIds: string[];
}
export interface BTSketchRegionQuery {
  btType: "BTMIndividualSketchRegionQuery-140";
  featureId: string;
  deterministicIds?: string[];
}
export type BTQuery = BTIndividualQuery | BTSketchRegionQuery;
export interface BTParameterQueryList {
  btType: "BTMParameterQueryList-148";
  parameterId: string;
  queries: BTQuery[];
}
export type BTParameter =
  | BTParameterQuantity
  | BTParameterEnum
  | BTParameterBoolean
  | BTParameterString
  | BTParameterQueryList;

export interface BTCurveGeometryLine {
  btType: "BTCurveGeometryLine-117";
  pntX: number;
  pntY: number;
  dirX: number;
  dirY: number;
}
export interface BTCurveGeometryCircle {
  btType: "BTCurveGeometryCircle-115";
  radius: number;
  xCenter: number;
  yCenter: number;
  xDir: number;
  yDir: number;
  clockwise: boolean;
}
export interface BTSketchPoint {
  btType: "BTMSketchPoint-158";
  entityId: string;
  x: number;
  y: number;
  isConstruction?: boolean;
}
export interface BTSketchCurve {
  btType: "BTMSketchCurve-4";
  entityId: string;
  geometry: BTCurveGeometryCircle;
  centerId: string;
  isConstruction?: boolean;
}
export interface BTSketchCurveSegment {
  btType: "BTMSketchCurveSegment-155";
  entityId: string;
  geometry: BTCurveGeometryLine | BTCurveGeometryCircle;
  startParam: number;
  endParam: number;
  startPointId: string;
  endPointId: string;
  isConstruction?: boolean;
}
export type BTSketchEntity = BTSketchPoint | BTSketchCurve | BTSketchCurveSegment;

export interface BTSketchConstraint {
  btType: "BTMSketchConstraint-2";
  constraintType: string;
  entityId: string;
  parameters: BTParameter[];
}

export interface BTMSketch {
  btType: "BTMSketch-151";
  featureType: "newSketch";
  name: string;
  featureId?: string;
  parameters: BTParameter[];
  entities: BTSketchEntity[];
  constraints: BTSketchConstraint[];
}
export interface BTMFeature {
  btType: "BTMFeature-134";
  featureType: string;
  name: string;
  featureId?: string;
  namespace?: string;
  parameters: BTParameter[];
}
export type BTFeature = BTMSketch | BTMFeature;

export interface BTFeatureDefinitionCall {
  btType: "BTFeatureDefinitionCall-1406";
  feature: BTFeature;
  serializationVersion?: string;
  sourceMicroversion?: string;
  libraryVersion?: number;
}

export interface FeatureState {
  featureStatus: "OK" | "WARNING" | "ERROR" | string;
  inactive?: boolean;
}

export interface FeatureListResponse {
  features: BTFeature[];
  defaultFeatures?: BTFeature[];
  rollbackIndex: number;
  serializationVersion: string;
  sourceMicroversion: string;
  libraryVersion?: number;
  featureStates?: Record<string, FeatureState>;
}

export interface AddFeatureResponse {
  feature: BTFeature;
  featureState?: FeatureState;
  serializationVersion: string;
  sourceMicroversion: string;
  libraryVersion?: number;
}

/** `GET .../massproperties?massAsGroup=true`. Arrays are [value, min, max]. SI. */
export interface MassPropertiesBody {
  hasMass: boolean;
  volume: number[];
  /** Surface area. */
  periphery: number[];
  centroid: number[];
  mass?: number[];
  inertia?: number[];
}
export interface MassPropertiesResponse {
  bodies: Record<string, MassPropertiesBody>;
}

export interface DocumentRef {
  did: string;
  wid: string;
  eid: string;
}
