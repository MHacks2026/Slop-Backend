import type { AuthProvider } from "./auth.ts";

export class OnshapeHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(`${method} ${path} -> ${status}${body ? `: ${body.slice(0, 500)}` : ""}`);
    this.name = "OnshapeHttpError";
  }
}

/** HTTP 402: the account's annual API call quota is exhausted. */
export class OnshapeQuotaError extends OnshapeHttpError {}

export interface HttpOptions {
  baseUrl: string;
  auth: AuthProvider;
  fetchImpl?: typeof fetch;
  /** Retries on 429 and 5xx. */
  maxRetries?: number;
}

export interface CallStats {
  calls: number;
  retries: number;
  byPath: Record<string, number>;
}

/**
 * Thin fetch wrapper: auth headers, JSON, retry on 429/5xx, and a call
 * counter. The counter matters: Onshape meters API calls per user per year
 * (2,500 to 10,000 depending on plan), so every build reports its cost.
 */
export class OnshapeHttp {
  readonly stats: CallStats = { calls: 0, retries: 0, byPath: {} };
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;

  constructor(private readonly opts: HttpOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 4;
  }

  async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    init: { query?: Record<string, string | number | boolean>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(path, this.opts.baseUrl);
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, String(v));
    const contentType = "application/json";
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);

    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        accept: "application/json;charset=UTF-8; qs=0.09",
        ...this.opts.auth.headers({ method, url, contentType }),
      };
      if (body !== undefined) headers["content-type"] = contentType;

      this.stats.calls++;
      const key = `${method} ${templatePath(url.pathname)}`;
      this.stats.byPath[key] = (this.stats.byPath[key] ?? 0) + 1;

      const res = await this.fetchImpl(url, { method, headers, body });
      if (res.ok) {
        if (res.status === 204) return undefined as T;
        return (await res.json()) as T;
      }

      const text = await res.text().catch(() => "");
      if (res.status === 402) throw new OnshapeQuotaError(402, method, url.pathname, text);

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= this.maxRetries) throw new OnshapeHttpError(res.status, method, url.pathname, text);

      this.stats.retries++;
      const retryAfter = Number(res.headers.get("retry-after"));
      const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

/** Collapse ids so stats group by endpoint: /d/abc/w/def -> /d/:did/w/:wid */
function templatePath(pathname: string): string {
  return pathname.replace(/\/(d|w|v|m|e)\/[A-Za-z0-9]+/g, "/$1/:id").replace(/\/featureid\/[^/]+/g, "/featureid/:fid");
}
