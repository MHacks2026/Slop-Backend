/**
 * FeatureScript lambdas evaluated through `POST .../featurescript`.
 *
 * Each returns plain maps/arrays so `decodeFsValue` can turn them into JS.
 * Entity ids come from `transientQueriesToStrings`, which yields the
 * deterministic ids that `BTMIndividualQuery-138.deterministicIds` accepts.
 * Enums are converted with `toString` so they arrive as strings.
 */

const fsString = (s: string): string => JSON.stringify(s);

/**
 * All faces/edges/vertices created by a feature, with geometric signatures.
 * `featureId` is the Onshape feature id (from the add-feature response), or
 * "Top" / "Front" / "Right" / "Origin" for the default datums.
 */
export function topologyScript(featureId: string, entity: "face" | "edge" | "vertex"): string {
  const entityType = { face: "FACE", edge: "EDGE", vertex: "VERTEX" }[entity];
  const body = { face: FACE_BODY, edge: EDGE_BODY, vertex: VERTEX_BODY }[entity];
  return `function(context is Context, queries) {
  const entities = evaluateQuery(context, qCreatedBy(makeId(${fsString(featureId)}), EntityType.${entityType}));
  var out = [];
  for (var e in entities) {
    var rec = { "ids" : transientQueriesToStrings([e]) };
${body}
    out = append(out, rec);
  }
  return out;
}`;
}

const FACE_BODY = `    const def = evSurfaceDefinition(context, { "face" : e });
    rec["type"] = toString(def.surfaceType);
    rec["area"] = evArea(context, { "entities" : e });
    rec["centroid"] = evApproximateCentroid(context, { "entities" : e });
    if (def.surfaceType == SurfaceType.PLANE) {
      rec["origin"] = def.origin; rec["normal"] = def.normal; rec["x"] = def.x;
    } else if (def.surfaceType == SurfaceType.CYLINDER) {
      rec["origin"] = def.coordSystem.origin; rec["axis"] = def.coordSystem.zAxis; rec["radius"] = def.radius;
    } else if (def.surfaceType == SurfaceType.CONE) {
      rec["origin"] = def.coordSystem.origin; rec["axis"] = def.coordSystem.zAxis;
    } else if (def.surfaceType == SurfaceType.SPHERE) {
      rec["origin"] = def.coordSystem.origin; rec["radius"] = def.radius;
    } else if (def.surfaceType == SurfaceType.TORUS) {
      rec["origin"] = def.coordSystem.origin; rec["axis"] = def.coordSystem.zAxis;
      rec["radius"] = def.majorRadius; rec["minorRadius"] = def.minorRadius;
    }`;

const EDGE_BODY = `    const def = evCurveDefinition(context, { "edge" : e });
    rec["length"] = evLength(context, { "entities" : e });
    rec["midpoint"] = evEdgeTangentLine(context, { "edge" : e, "parameter" : 0.5 }).origin;
    if (def is Line) {
      rec["type"] = "LINE"; rec["origin"] = def.origin; rec["direction"] = def.direction;
    } else if (def is Circle) {
      rec["type"] = "CIRCLE"; rec["center"] = def.coordSystem.origin; rec["axis"] = def.coordSystem.zAxis; rec["radius"] = def.radius;
    } else if (def is Ellipse) {
      rec["type"] = "ELLIPSE"; rec["center"] = def.coordSystem.origin; rec["axis"] = def.coordSystem.zAxis;
      rec["radius"] = def.majorRadius; rec["minorRadius"] = def.minorRadius;
    } else {
      rec["type"] = "BSPLINE";
    }`;

const VERTEX_BODY = `    rec["type"] = "VERTEX";
    rec["point"] = evVertexPoint(context, { "vertex" : e });`;

/** Plane (origin, x, normal) Onshape assigned to a sketch, read from any entity it created. */
export function sketchPlaneScript(sketchFeatureId: string): string {
  return `function(context is Context, queries) {
  const q = qCreatedBy(makeId(${fsString(sketchFeatureId)}), EntityType.EDGE);
  if (size(evaluateQuery(context, q)) == 0) return undefined;
  const p = evOwnerSketchPlane(context, { "entity" : q });
  return { "origin" : p.origin, "x" : p.x, "normal" : p.normal };
}`;
}

/**
 * Counts, face-type histogram and centroid of all solid bodies: evidence for
 * Level 1 checks. The centroid comes from FeatureScript because the REST
 * massproperties endpoint reports (0,0,0) for parts with no material assigned.
 */
export const bodyStatsScript = `function(context is Context, queries) {
  const bodies = evaluateQuery(context, qAllModifiableSolidBodies());
  const faces = evaluateQuery(context, qOwnedByBody(qAllModifiableSolidBodies(), EntityType.FACE));
  var types = {};
  for (var f in faces) {
    const t = toString(evSurfaceDefinition(context, { "face" : f }).surfaceType);
    types[t] = (types[t] == undefined ? 0 : types[t]) + 1;
  }
  return {
    "bodyCount" : size(bodies),
    "faceCount" : size(faces),
    "edgeCount" : size(evaluateQuery(context, qOwnedByBody(qAllModifiableSolidBodies(), EntityType.EDGE))),
    "vertexCount" : size(evaluateQuery(context, qOwnedByBody(qAllModifiableSolidBodies(), EntityType.VERTEX))),
    "faceTypes" : types,
    "centroid" : size(bodies) > 0 ? evApproximateCentroid(context, { "entities" : qAllModifiableSolidBodies() }) : undefined
  };
}`;
