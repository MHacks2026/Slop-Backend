import { basicAuth, hmacAuth } from "./auth.ts";
import { OnshapeHttp } from "./http.ts";
import type { OnshapeApi } from "./api.ts";
import type {
  AddFeatureResponse,
  BTFeature,
  BTFeatureDefinitionCall,
  DocumentRef,
  FeatureListResponse,
  MassPropertiesBody,
  MassPropertiesResponse,
} from "./types.ts";
import type { OnshapeConfig } from "../env.ts";
import { decodeFsValue, isRecord } from "../fs/values.ts";

interface WorkspaceVersions {
  serializationVersion: string;
  sourceMicroversion: string;
  libraryVersion?: number;
}

/**
 * REST client over the endpoints the builder uses. Hand-written rather than
 * generated: the OpenAPI spec is several MB and the builder needs ~8 calls.
 * Replace with a generated client when the surface grows.
 */
export class OnshapeClient implements OnshapeApi {
  readonly http: OnshapeHttp;
  private readonly v: string;
  /** Per-workspace feature-list versions, required on every feature POST. */
  private readonly versions = new Map<string, WorkspaceVersions>();

  constructor(cfg: OnshapeConfig, fetchImpl?: typeof fetch) {
    const auth = cfg.authScheme === "hmac" ? hmacAuth(cfg.accessKey, cfg.secretKey) : basicAuth(cfg.accessKey, cfg.secretKey);
    this.http = new OnshapeHttp({ baseUrl: cfg.baseUrl, auth, ...(fetchImpl ? { fetchImpl } : {}) });
    this.v = cfg.apiVersion;
  }

  callCount(): number {
    return this.http.stats.calls;
  }

  async createDocument(name: string): Promise<DocumentRef> {
    const doc = await this.http.request<{ id: string; defaultWorkspace: { id: string } }>("POST", `/api/${this.v}/documents`, {
      body: { name, ownerType: 0, isPublic: false },
    });
    const did = doc.id;
    const wid = doc.defaultWorkspace.id;
    const elements = await this.http.request<Array<{ id: string; elementType: string; name: string }>>(
      "GET",
      `/api/${this.v}/documents/d/${did}/w/${wid}/elements`,
    );
    const ps = elements.find((e) => e.elementType === "PARTSTUDIO");
    if (!ps) throw new Error(`new document ${did} has no Part Studio`);
    return { did, wid, eid: ps.id };
  }

  async getFeatures(ref: DocumentRef): Promise<FeatureListResponse> {
    const res = await this.http.request<FeatureListResponse>("GET", `${this.psPath(ref)}/features`, {
      query: { includeGeometryIds: true, noSketchGeometry: false },
    });
    this.remember(ref, res);
    return res;
  }

  async addFeature(ref: DocumentRef, feature: BTFeature): Promise<AddFeatureResponse> {
    const versions = this.versions.get(key(ref)) ?? (await this.getFeatures(ref), this.versions.get(key(ref))!);
    const body: BTFeatureDefinitionCall = {
      btType: "BTFeatureDefinitionCall-1406",
      feature,
      serializationVersion: versions.serializationVersion,
      sourceMicroversion: versions.sourceMicroversion,
      ...(versions.libraryVersion !== undefined ? { libraryVersion: versions.libraryVersion } : {}),
    };
    const res = await this.http.request<AddFeatureResponse>("POST", `${this.psPath(ref)}/features`, { body });
    this.remember(ref, res);
    return res;
  }

  async evaluateFeatureScript(ref: DocumentRef, script: string): Promise<unknown> {
    const res = await this.http.request<{ result?: unknown; notices?: unknown[] }>("POST", `${this.psPath(ref)}/featurescript`, {
      body: { script, queries: {} },
    });
    const errors = (res.notices ?? []).filter((n) => isRecord(n) && n.level === "ERROR");
    if (errors.length) throw new Error(`FeatureScript errors: ${JSON.stringify(errors).slice(0, 1000)}`);
    return decodeFsValue(res.result);
  }

  async massProperties(ref: DocumentRef): Promise<MassPropertiesBody | undefined> {
    const res = await this.http.request<MassPropertiesResponse>("GET", `${this.psPath(ref)}/massproperties`, {
      query: { massAsGroup: true },
    });
    return res.bodies["-all-"] ?? Object.values(res.bodies)[0];
  }

  /** `POST .../features/featureid/{fid}` with the full feature definition (architecture doc §4, "Update or delete a feature"). */
  async updateFeature(ref: DocumentRef, featureId: string, feature: BTFeature): Promise<AddFeatureResponse> {
    const versions = this.versions.get(key(ref)) ?? (await this.getFeatures(ref), this.versions.get(key(ref))!);
    const body: BTFeatureDefinitionCall = {
      btType: "BTFeatureDefinitionCall-1406",
      feature: { ...feature, featureId },
      serializationVersion: versions.serializationVersion,
      sourceMicroversion: versions.sourceMicroversion,
      ...(versions.libraryVersion !== undefined ? { libraryVersion: versions.libraryVersion } : {}),
    };
    const res = await this.http.request<AddFeatureResponse>("POST", `${this.psPath(ref)}/features/featureid/${encodeURIComponent(featureId)}`, { body });
    this.remember(ref, res);
    return res;
  }

  async deleteFeature(ref: DocumentRef, featureId: string): Promise<void> {
    await this.http.request("DELETE", `${this.psPath(ref)}/features/featureid/${encodeURIComponent(featureId)}`);
    this.versions.delete(key(ref)); // microversion moved; refetch before the next POST
  }

  /** Parameter specs of Onshape's native features. [spec mirror]: endpoint confirmed only in a third-party OpenAPI mirror. */
  async featureSpecs(ref: DocumentRef): Promise<unknown> {
    return this.http.request("GET", `${this.psPath(ref)}/featurespecs`);
  }

  /** Shaded isometric view as base64 PNG. */
  async shadedView(ref: DocumentRef): Promise<string | undefined> {
    const res = await this.http.request<{ images?: string[] }>("GET", `${this.psPath(ref)}/shadedviews`, {
      query: { viewMatrix: "isometric", outputHeight: 512, outputWidth: 512, pixelSize: 0 },
    });
    return res.images?.[0];
  }

  /** Move the rollback bar (0 = before the first feature). */
  async rollback(ref: DocumentRef, rollbackIndex: number): Promise<void> {
    const versions = this.versions.get(key(ref)) ?? (await this.getFeatures(ref), this.versions.get(key(ref))!);
    await this.http.request("POST", `${this.psPath(ref)}/features/rollback`, {
      body: { rollbackIndex, serializationVersion: versions.serializationVersion, sourceMicroversion: versions.sourceMicroversion },
    });
  }

  private psPath({ did, wid, eid }: DocumentRef): string {
    return `/api/${this.v}/partstudios/d/${did}/w/${wid}/e/${eid}`;
  }

  private remember(ref: DocumentRef, res: { serializationVersion: string; sourceMicroversion: string; libraryVersion?: number }): void {
    this.versions.set(key(ref), {
      serializationVersion: res.serializationVersion,
      sourceMicroversion: res.sourceMicroversion,
      ...(res.libraryVersion !== undefined ? { libraryVersion: res.libraryVersion } : {}),
    });
  }
}

function key(ref: DocumentRef): string {
  return `${ref.did}/${ref.wid}/${ref.eid}`;
}
