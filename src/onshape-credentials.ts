import { Hono } from "hono";
import { requireUser, type UserEnv } from "./auth";
import { DbError } from "./builds";

/**
 * The signed-in user's Onshape API keys. The web app sends them once, at
 * sign-up, and every build the user requests runs with them (the runner
 * reads them per build), so the Onshape document lands in their account.
 *
 * Keys are checked against Onshape before they are stored. The secret key
 * is never returned; reads only say whether keys are on file and whose
 * Onshape account they belong to.
 */

export const ONSHAPE_BASE_URL = "https://cad.onshape.com";

export interface OnshapeAccount {
  accessKey: string;
  onshapeUserId: string | null;
  onshapeName: string | null;
  verifiedAt: string;
}

export interface OnshapeCredentialsDb {
  /** Calls set_onshape_credentials(): stores or replaces the user's keys. */
  save(input: { uid: string; accessKey: string; secretKey: string; onshapeUserId: string; onshapeName: string | null }): Promise<void>;
  get(uid: string): Promise<OnshapeAccount | null>;
  /** Returns whether there was anything to remove. */
  remove(uid: string): Promise<boolean>;
}

export type KeyCheck = { ok: true; user: { id: string; name: string | null } } | { ok: false };

export interface OnshapeCredentialDeps {
  verifyToken(token: string): Promise<{ uid: string }>;
  /** Asks Onshape whose keys these are. Throws when Onshape can't be reached. */
  checkKeys(accessKey: string, secretKey: string): Promise<KeyCheck>;
  db: OnshapeCredentialsDb;
}

export function onshapeCredentialRoutes(deps: OnshapeCredentialDeps): Hono<UserEnv> {
  const app = new Hono<UserEnv>();
  app.use("*", requireUser(deps.verifyToken));

  // PUT /api/me/onshape  { accessKey, secretKey }
  app.put("/me/onshape", async (c) => {
    let body: { accessKey?: unknown; secretKey?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const problem = checkKeysRequest(body);
    if (problem) return c.json({ error: problem }, 400);
    const accessKey = (body.accessKey as string).trim();
    const secretKey = (body.secretKey as string).trim();

    let check: KeyCheck;
    try {
      check = await deps.checkKeys(accessKey, secretKey);
    } catch (err) {
      console.error(err);
      return c.json({ error: "couldn't reach Onshape to check the keys; try again" }, 502);
    }
    if (!check.ok) return c.json({ error: "Onshape rejected these API keys" }, 400);

    const uid = c.get("uid");
    try {
      await deps.db.save({ uid, accessKey, secretKey, onshapeUserId: check.user.id, onshapeName: check.user.name });
    } catch (err) {
      if (err instanceof DbError && err.code === "23503") return c.json({ error: "no profile for this user yet; call ensure_profile first" }, 409);
      if (err instanceof DbError && err.code === "22023") return c.json({ error: err.message }, 400);
      console.error(err);
      return c.json({ error: "internal error" }, 500);
    }
    return c.json(describe({ accessKey, onshapeUserId: check.user.id, onshapeName: check.user.name, verifiedAt: new Date().toISOString() }));
  });

  // GET /api/me/onshape
  app.get("/me/onshape", async (c) => {
    const account = await deps.db.get(c.get("uid"));
    return c.json(account ? describe(account) : { connected: false });
  });

  // DELETE /api/me/onshape
  app.delete("/me/onshape", async (c) => {
    await deps.db.remove(c.get("uid"));
    return c.json({ connected: false });
  });

  return app;
}

/** What clients may see: never the secret key, only the end of the access key. */
function describe(a: OnshapeAccount) {
  return {
    connected: true,
    accessKeyHint: `…${a.accessKey.slice(-4)}`,
    onshapeUser: { id: a.onshapeUserId, name: a.onshapeName },
    verifiedAt: a.verifiedAt,
  };
}

// Onshape keys are printable ASCII; this also keeps them safe to base64 for Basic auth.
const KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;

export function checkKeysRequest(body: { accessKey?: unknown; secretKey?: unknown }): string | undefined {
  if (typeof body.accessKey !== "string" || !KEY_PATTERN.test(body.accessKey.trim())) return "accessKey must be an Onshape API access key";
  if (typeof body.secretKey !== "string" || !KEY_PATTERN.test(body.secretKey.trim())) return "secretKey must be an Onshape API secret key";
  return undefined;
}

/**
 * Valid keys get 200 and the account from /users/sessioninfo. Invalid or
 * missing keys get 204 with no body there, not 401, so anything without an
 * account id counts as rejected.
 */
export async function checkOnshapeKeys(accessKey: string, secretKey: string, fetchImpl: typeof fetch = fetch): Promise<KeyCheck> {
  const res = await fetchImpl(`${ONSHAPE_BASE_URL}/api/v10/users/sessioninfo`, {
    headers: { accept: "application/json", authorization: `Basic ${btoa(`${accessKey}:${secretKey}`)}` },
  });
  if (res.status === 200) {
    const info = (await res.json()) as { id?: unknown; name?: unknown };
    if (typeof info.id === "string" && info.id) return { ok: true, user: { id: info.id, name: typeof info.name === "string" ? info.name : null } };
    return { ok: false };
  }
  if (res.status === 204 || res.status === 401 || res.status === 403) return { ok: false };
  throw new Error(`Onshape sessioninfo returned ${res.status}`);
}
