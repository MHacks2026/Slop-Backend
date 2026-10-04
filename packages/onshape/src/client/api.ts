import type { AddFeatureResponse, BTFeature, DocumentRef, FeatureListResponse, MassPropertiesBody } from "./types.ts";

/**
 * The slice of Onshape the builder needs. The real client implements it over
 * REST; tests implement it with a fake. Keeping the builder on this interface
 * is what lets the Phase 0 loop be exercised without an API key.
 */
export interface OnshapeApi {
  /** Create a document and return its default workspace and Part Studio. */
  createDocument(name: string): Promise<DocumentRef>;
  getFeatures(ref: DocumentRef): Promise<FeatureListResponse>;
  addFeature(ref: DocumentRef, feature: BTFeature): Promise<AddFeatureResponse>;
  /**
   * Evaluate a FeatureScript lambda `function(context is Context, queries) {...}`
   * in the Part Studio and return its decoded result (plain JS values).
   */
  evaluateFeatureScript(ref: DocumentRef, script: string): Promise<unknown>;
  /** Mass properties of all solid bodies as one group. */
  massProperties(ref: DocumentRef): Promise<MassPropertiesBody | undefined>;
  /** Remove a feature; used to undo a failed attempt before the translator retries. */
  deleteFeature(ref: DocumentRef, featureId: string): Promise<void>;
  /** Replace a feature's definition in place (behaviour tests change a dimension this way). */
  updateFeature(ref: DocumentRef, featureId: string, feature: BTFeature): Promise<AddFeatureResponse>;
  /** Onshape's parameter specs for native features (tool for the translator). Optional. */
  featureSpecs?(ref: DocumentRef): Promise<unknown>;
  /** PNG of the current model, base64. Optional; feedback image for the translator. */
  shadedView?(ref: DocumentRef): Promise<string | undefined>;
  /** Total API calls made so far. */
  callCount(): number;
}
