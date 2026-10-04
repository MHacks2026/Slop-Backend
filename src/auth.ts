import type { MiddlewareHandler } from "hono";

export type UserEnv = { Variables: { uid: string } };

/** Verifies the Firebase ID token in `Authorization: Bearer` and sets `uid`, or answers 401. */
export function requireUser(verifyToken: (token: string) => Promise<{ uid: string }>): MiddlewareHandler<UserEnv> {
  return async (c, next) => {
    const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return c.json({ error: "missing bearer token" }, 401);
    try {
      const { uid } = await verifyToken(token);
      c.set("uid", uid);
    } catch {
      return c.json({ error: "invalid token" }, 401);
    }
    await next();
  };
}
