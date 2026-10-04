/**
 * Onshape document links, as copied from the browser's address bar:
 *
 *   https://cad.onshape.com/documents/<did>/w/<wid>/e/<eid>
 *   https://cad.onshape.com/documents/<did>
 *   https://acme.onshape.com/documents/<did>/w/<wid>     (Enterprise)
 *
 * The API base URL comes from the link, so Enterprise documents work. Only
 * onshape.com hosts are accepted: the user's API keys are sent to that host.
 */

export interface DocumentLink {
  /** e.g. https://cad.onshape.com */
  baseUrl: string;
  did: string;
  /** Workspace id; absent when the link names only the document. */
  wid?: string;
  /** Element (tab) id; absent when the link names no tab. */
  eid?: string;
}

export class LinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkError";
  }
}

const ID = /^[0-9a-f]{24}$/i;

export function parseDocumentLink(input: string): DocumentLink {
  const text = input.trim();
  if (!text) throw new LinkError("Paste the link of an Onshape document.");
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new LinkError("That is not a link. Copy it from the address bar while the document is open in Onshape.");
  }
  const host = url.hostname.toLowerCase();
  if (host !== "onshape.com" && !host.endsWith(".onshape.com")) {
    throw new LinkError(`Expected an onshape.com link, got ${host}.`);
  }
  if (url.protocol !== "https:") throw new LinkError("Onshape links start with https://");

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "documents" || !parts[1] || !ID.test(parts[1])) {
    throw new LinkError("That link does not point to a document. Open the document in Onshape and copy the address bar.");
  }
  const link: DocumentLink = { baseUrl: `https://${url.host}`, did: parts[1] };

  const kind = parts[2];
  if (kind === undefined) return link;
  if (kind === "v" || kind === "m") {
    throw new LinkError("That link points to a version, which is read-only. Switch to the Main workspace in Onshape and copy that link.");
  }
  if (kind !== "w" || !parts[3] || !ID.test(parts[3])) throw new LinkError("Couldn't read the workspace in that link.");
  link.wid = parts[3];

  if (parts[4] === "e" && parts[5] && ID.test(parts[5])) link.eid = parts[5];
  return link;
}

export const documentUrl = (link: { baseUrl: string; did: string; wid: string; eid?: string }): string =>
  `${link.baseUrl}/documents/${link.did}/w/${link.wid}${link.eid ? `/e/${link.eid}` : ""}`;
