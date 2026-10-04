/**
 * Who is asking, and with which Onshape keys.
 *
 * The web app sends the signed-in user's Firebase ID token. The studio
 * server verifies it the way the Worker does (src/firebase.ts), then reads
 * that user's Onshape keys from Supabase with the service role
 * (user_onshape_credentials, migration 0006). Keys go in once, at sign-up,
 * through the Worker's PUT /api/me/onshape; the browser never sees the
 * secret again.
 */
import { createClient } from "@supabase/supabase-js";
import { createRemoteJWKSet, jwtVerify } from "jose";

export interface OnshapeKeys {
  accessKey: string;
  secretKey: string;
  onshapeName: string | null;
}

export interface Accounts {
  /** The Firebase uid for a valid ID token; throws otherwise. */
  verify(token: string): Promise<string>;
  /** The user's Onshape keys, or null when they have none on file. */
  keysFor(uid: string): Promise<OnshapeKeys | null>;
}

export interface AccountsConfig {
  firebaseProjectId: string;
  supabaseUrl: string;
  /** Service role (secret) key: user_onshape_credentials is not callable by clients. */
  supabaseSecretKey: string;
}

// Firebase ID tokens are signed by this Google service account.
const FIREBASE_JWKS = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

export function firebaseSupabaseAccounts(cfg: AccountsConfig): Accounts {
  const jwks = createRemoteJWKSet(new URL(FIREBASE_JWKS));
  const sb = createClient(cfg.supabaseUrl, cfg.supabaseSecretKey, { auth: { persistSession: false, autoRefreshToken: false } });

  return {
    async verify(token) {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: `https://securetoken.google.com/${cfg.firebaseProjectId}`,
        audience: cfg.firebaseProjectId,
      });
      if (!payload.sub) throw new Error("token has no subject");
      return payload.sub;
    },

    async keysFor(uid) {
      const { data, error } = await sb.rpc("user_onshape_credentials", { p_uid: uid });
      if (error) throw new AccountsError(`user_onshape_credentials: ${error.message}`, error.code);
      const row = ((data ?? []) as Array<{ access_key: string; secret_key: string; onshape_name: string | null }>)[0];
      return row ? { accessKey: row.access_key, secretKey: row.secret_key, onshapeName: row.onshape_name } : null;
    },
  };
}

/** A database failure while reading keys; `code` is the Postgres SQLSTATE or PostgREST code. */
export class AccountsError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "AccountsError";
  }
}
