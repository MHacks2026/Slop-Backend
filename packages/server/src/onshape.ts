import { OnshapeClient, OnshapeHttpError, type DocumentRef, type OnshapeApi, type OnshapeConfig } from "@slop/onshape";

export interface DocumentInfo {
  id: string;
  name: string;
  owner?: { name?: string };
  defaultWorkspace?: { id: string };
  /** e.g. ["READ", "WRITE", ...]; absent on some API versions. */
  permissionSet?: string[];
}

export interface ElementInfo {
  id: string;
  name: string;
  elementType: string;
}

/**
 * What the studio needs from Onshape: the builder's slice plus document-level
 * calls (who owns it, its tabs, a new Part Studio) and tessellation for the
 * live viewer. Tests implement it over the fake.
 */
export interface StudioOnshape extends OnshapeApi {
  getDocument(did: string): Promise<DocumentInfo>;
  getElements(did: string, wid: string): Promise<ElementInfo[]>;
  createPartStudio(did: string, wid: string, name: string): Promise<ElementInfo>;
  /** Raw `tessellatedfaces` response with an index table; see mesh.ts. */
  tessellatedFaces(ref: DocumentRef): Promise<unknown>;
}

export class StudioClient extends OnshapeClient implements StudioOnshape {
  private readonly version: string;

  constructor(cfg: OnshapeConfig) {
    super(cfg);
    this.version = cfg.apiVersion;
  }

  getDocument(did: string): Promise<DocumentInfo> {
    return this.http.request<DocumentInfo>("GET", `/api/${this.version}/documents/${did}`);
  }

  getElements(did: string, wid: string): Promise<ElementInfo[]> {
    return this.http.request<ElementInfo[]>("GET", `/api/${this.version}/documents/d/${did}/w/${wid}/elements`);
  }

  async createPartStudio(did: string, wid: string, name: string): Promise<ElementInfo> {
    const res = await this.http.request<{ id: string; name: string }>("POST", `/api/${this.version}/partstudios/d/${did}/w/${wid}`, { body: { name } });
    return { id: res.id, name: res.name ?? name, elementType: "PARTSTUDIO" };
  }

  tessellatedFaces({ did, wid, eid }: DocumentRef): Promise<unknown> {
    return this.http.request("GET", `/api/${this.version}/partstudios/d/${did}/w/${wid}/e/${eid}/tessellatedfaces`, {
      query: { outputVertexNormals: true, outputFacetNormals: false, outputIndexTable: true, outputFaceAppearances: false, outputErrorFaces: false },
    });
  }
}

/** A message for the person at the keyboard, from whatever Onshape said. */
export function explainOnshapeError(err: unknown): { status: number; message: string } {
  if (err instanceof OnshapeHttpError) {
    if (err.status === 401) return { status: 401, message: "Onshape rejected those API keys. Check the access key and secret key (dev-portal.onshape.com → API keys)." };
    // Onshape answers 403 both for a wrong secret key and for a document the account can't open.
    if (err.status === 403) return { status: 403, message: "Onshape refused. Check the access key and secret key, and that their account can edit this document (keys need read and write scopes)." };
    if (err.status === 404) return { status: 404, message: "Onshape couldn't find that document or tab. Check the link." };
    if (err.status === 402) return { status: 402, message: "This Onshape account has used up its yearly API call quota." };
    if (err.status === 429) return { status: 429, message: "Onshape is rate-limiting these keys. Wait a minute and try again." };
    return { status: 502, message: `Onshape answered ${err.status}: ${err.body.slice(0, 200) || err.message}` };
  }
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) return { status: 502, message: "Couldn't reach Onshape. Check the internet connection." };
  return { status: 500, message: err instanceof Error ? err.message : String(err) };
}
