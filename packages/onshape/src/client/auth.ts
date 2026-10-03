import { createHmac, randomBytes } from "node:crypto";

export interface RequestContext {
  method: string;
  url: URL;
  contentType: string;
}

export interface AuthProvider {
  headers(ctx: RequestContext): Record<string, string>;
}

/** API key as HTTP Basic credentials. */
export function basicAuth(accessKey: string, secretKey: string): AuthProvider {
  const token = Buffer.from(`${accessKey}:${secretKey}`, "utf8").toString("base64");
  return { headers: () => ({ authorization: `Basic ${token}` }) };
}

/**
 * Onshape's HMAC-SHA256 request signing for API keys:
 *   lower(method \n nonce \n date \n content-type \n path \n query \n)
 *   Authorization: On <accessKey>:HmacSHA256:<base64 signature>
 */
export function hmacAuth(accessKey: string, secretKey: string): AuthProvider {
  return {
    headers({ method, url, contentType }) {
      const nonce = randomBytes(16).toString("hex");
      const date = new Date().toUTCString();
      const query = url.search.startsWith("?") ? url.search.slice(1) : url.search;
      const toSign = [method, nonce, date, contentType, url.pathname, query, ""].join("\n").toLowerCase();
      const signature = createHmac("sha256", secretKey).update(toSign, "utf8").digest("base64");
      return {
        authorization: `On ${accessKey}:HmacSHA256:${signature}`,
        date,
        "on-nonce": nonce,
      };
    },
  };
}
