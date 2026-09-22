import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dotenv from 'dotenv';

const SCRIPT_LIB_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Load env files from RAG_CONFIG_DIR if set (production mode).
 * Must run before REPO_ROOT computation so env vars like RAG_REPO_ROOT
 * can be defined in the config directory's .env.local.
 *
 * Precedence when RAG_CONFIG_DIR is set:
 * 1. process.env values already present at module start (shell or outer env)
 *    — dotenv must not override these.
 * 2. .env.prod.local overrides .env.local for keys the shell did NOT already set.
 * 3. .env.local fills remaining missing keys.
 */
let configDirUsed = false;
const configDirRaw = process.env.RAG_CONFIG_DIR;
const configDirValue = configDirRaw?.trim().replace(/^['"]|['"]$/g, '') ?? undefined;
if (configDirValue) {
  if (!isAbsolute(configDirValue)) {
    throw new Error('RAG_CONFIG_DIR must be an absolute path to an existing directory');
  }
  const configDir = resolve(configDirValue);
  if (!existsSync(configDir) || !statSync(configDir).isDirectory()) {
    throw new Error('RAG_CONFIG_DIR must be an absolute path to an existing directory');
  }

  // Snapshot keys present before any file-based loading — shell env always wins.
  const originalProcessEnvKeys = new Set(Object.keys(process.env));

  const configEnvPath = join(configDir, '.env.local');
  if (existsSync(configEnvPath)) {
    dotenv.config({ path: configEnvPath, quiet: true });
  }

  const configProdEnvPath = join(configDir, '.env.prod.local');
  if (existsSync(configProdEnvPath)) {
    // Load .env.prod.local manually so we can control override logic:
    // prod overrides local-file values but NOT keys that were already in
    // process.env before any dotenv loading.
    const prodRaw = readFileSync(configProdEnvPath, 'utf-8');
    const prodConfig = dotenv.parse(prodRaw);
    for (const [key, value] of Object.entries(prodConfig)) {
      if (!originalProcessEnvKeys.has(key)) {
        process.env[key] = value;
      }
    }
  }

  configDirUsed = true;
}

function resolveConfiguredRepoRoot(): string | undefined {
  const configured = [
    ['RAG_REPO_ROOT', process.env.RAG_REPO_ROOT],
    ['RAG_V2_ROOT', process.env.RAG_V2_ROOT],
  ] as const;

  for (const [key, rawValue] of configured) {
    const value = rawValue?.trim().replace(/^['"]|['"]$/g, '');
    if (!value) continue;

    if (!isAbsolute(value)) {
      throw new Error(`${key} must be an absolute path to an existing directory`);
    }

    const candidate = resolve(value);
    if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
      throw new Error(`${key} must be an absolute path to an existing directory`);
    }
    return candidate;
  }

  return undefined;
}

export const REPO_ROOT = resolveConfiguredRepoRoot() ?? resolve(SCRIPT_LIB_DIR, '..', '..');
export const REPO_ENV_PATH = join(REPO_ROOT, '.env.local');
export const REPO_DEV_ENV_PATH = join(REPO_ROOT, '.env.dev.local');
export const REPO_PROD_ENV_PATH = join(REPO_ROOT, '.env.prod.local');

let envLoaded = false;

export function ensureRepoEnvLoaded(): string {
  if (!envLoaded) {
    // Skip repo-relative env loading when RAG_CONFIG_DIR was used (production mode)
    // or when explicitly disabled via RAG_SKIP_REPO_ENV
    if (!configDirUsed && process.env.RAG_SKIP_REPO_ENV !== 'true') {
      dotenv.config({ path: REPO_ENV_PATH, quiet: true });
    }
    envLoaded = true;
  }

  return REPO_ENV_PATH;
}

export function resolveRepoPath(...segments: string[]): string {
  return join(REPO_ROOT, ...segments);
}

export function normalizeEnvValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.replace(/^['"]|['"]$/g, '') || undefined;
}

ensureRepoEnvLoaded();
