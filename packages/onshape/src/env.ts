import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface OnshapeConfig {
  baseUrl: string;
  accessKey: string;
  secretKey: string;
  authScheme: "basic" | "hmac";
  apiVersion: string;
}

export interface ClaudeEnv {
  apiKey: string;
  model: string;
  baseUrl: string;
}

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** Load packages/onshape/.env and cwd/.env if present. Safe to call more than once. */
export function loadEnvFiles(): void {
  for (const dir of new Set([PACKAGE_DIR, process.cwd()])) {
    const file = join(dir, ".env");
    if (existsSync(file)) {
      try {
        process.loadEnvFile(file);
      } catch {
        /* already loaded or unreadable */
      }
    }
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): OnshapeConfig {
  loadEnvFiles();
  const missing = ["ONSHAPE_ACCESS_KEY", "ONSHAPE_SECRET_KEY"].filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(
      `missing Onshape credentials: ${missing.join(", ")}. ` +
        `Copy packages/onshape/.env.example to packages/onshape/.env and fill it in.`,
    );
  }
  return {
    baseUrl: (env.ONSHAPE_BASE_URL ?? "https://cad.onshape.com").replace(/\/+$/, ""),
    accessKey: env.ONSHAPE_ACCESS_KEY!,
    secretKey: env.ONSHAPE_SECRET_KEY!,
    authScheme: env.ONSHAPE_AUTH_SCHEME === "hmac" ? "hmac" : "basic",
    apiVersion: env.ONSHAPE_API_VERSION ?? "v10",
  };
}

export function loadClaudeConfig(env: NodeJS.ProcessEnv = process.env): ClaudeEnv {
  loadEnvFiles();
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error(
      "missing ANTHROPIC_API_KEY. Copy packages/onshape/.env.example to packages/onshape/.env and fill it in.",
    );
  }
  return {
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
    baseUrl: (env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, ""),
  };
}
