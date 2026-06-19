import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { nowIso } from '../backend.js';

/**
 * Claude subscription usage limits (the 5-hour rolling window + weekly caps shown by Claude Code's
 * `/usage`). Sourced from the UNDOCUMENTED `GET https://api.anthropic.com/api/oauth/usage` endpoint,
 * authenticated with the Claude Code OAuth token. This only works for a Pro/Max subscription login
 * (not API-key auth) and is best-effort — Anthropic may change or remove it without notice. Kept here
 * in `agent-backends` (the Claude-specific seam); the orchestrator stays agent-neutral.
 */

const execFileAsync = promisify(execFile);

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
/** The endpoint 429s requests without a `claude-code/*` User-Agent; the exact version is not load-bearing. */
const DEFAULT_USER_AGENT = 'claude-code/2.0.0';
/** macOS Keychain service name under which Claude Code stores its OAuth credentials. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const DEFAULT_TIMEOUT_MS = 5000;

export interface UsageWindow {
  /** Percent of the window consumed (0–100). */
  utilization: number;
  /** ISO timestamp when this window resets. */
  resetsAt: string;
}

export type ClaudeUsageLimits =
  | { available: false; reason: string }
  | {
      available: true;
      fiveHour: UsageWindow;
      sevenDay: UsageWindow;
      /** Per-model weekly sub-limit on Max plans (absent/null otherwise). */
      sevenDayOpus?: UsageWindow;
      sevenDaySonnet?: UsageWindow;
      /** ISO timestamp the figures were fetched (for cache/staleness display). */
      fetchedAt: string;
    };

/** Injectable OAuth-token reader (test seam). Returns the access token or null when unavailable. */
export type CredentialReader = () => Promise<string | null>;

export interface UsageFetchOptions {
  /** Override the global `fetch` (tests). */
  fetchImpl?: typeof fetch;
  /** Request timeout in ms (default 5000). */
  timeoutMs?: number;
  /** Override the `claude-code/*` User-Agent. */
  userAgent?: string;
}

/** Pull the OAuth `accessToken` out of a Claude credentials JSON blob (file or Keychain value). */
function extractAccessToken(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: unknown };
      accessToken?: unknown;
    };
    const token = parsed.claudeAiOauth?.accessToken ?? parsed.accessToken;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/** Read `~/.claude/.credentials.json` (preferred — no Keychain prompt). */
async function readCredentialsFile(): Promise<string | null> {
  try {
    const file = path.join(os.homedir(), '.claude', '.credentials.json');
    return extractAccessToken(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Read the token from the macOS Keychain (may prompt for access on first use). */
async function readKeychainToken(): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { timeout: DEFAULT_TIMEOUT_MS },
    );
    return extractAccessToken(stdout);
  } catch {
    return null;
  }
}

/**
 * Resolve the Claude Code OAuth access token: try the credentials file first (avoids the macOS
 * Keychain access prompt), then fall back to the Keychain. Returns null when neither is available.
 */
export const readClaudeOAuthToken: CredentialReader = async () =>
  (await readCredentialsFile()) ?? (await readKeychainToken());

function parseWindow(v: unknown): UsageWindow | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.utilization !== 'number' || typeof o.resets_at !== 'string') return null;
  return { utilization: o.utilization, resetsAt: o.resets_at };
}

function parseUsageBody(body: unknown): ClaudeUsageLimits {
  if (typeof body !== 'object' || body === null) return { available: false, reason: 'shape' };
  const o = body as Record<string, unknown>;
  const fiveHour = parseWindow(o.five_hour);
  const sevenDay = parseWindow(o.seven_day);
  if (!fiveHour || !sevenDay) return { available: false, reason: 'shape' };
  const sevenDayOpus = parseWindow(o.seven_day_opus);
  const sevenDaySonnet = parseWindow(o.seven_day_sonnet);
  return {
    available: true,
    fiveHour,
    sevenDay,
    ...(sevenDayOpus ? { sevenDayOpus } : {}),
    ...(sevenDaySonnet ? { sevenDaySonnet } : {}),
    fetchedAt: nowIso(),
  };
}

/** Fetch usage limits with an already-resolved OAuth token. Never throws — maps failures to a reason. */
export async function fetchClaudeUsageLimits(
  token: string,
  opts: UsageFetchOptions = {},
): Promise<ClaudeUsageLimits> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(USAGE_URL, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA,
        'user-agent': opts.userAgent ?? DEFAULT_USER_AGENT,
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (e) {
    const reason = e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'network';
    return { available: false, reason };
  }
  if (!res.ok) return { available: false, reason: `http_${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { available: false, reason: 'parse' };
  }
  return parseUsageBody(body);
}

/**
 * Resolve the OAuth token and fetch the current Claude usage limits. Returns
 * `{ available: false, reason: 'no_token' }` in API-key mode / when no subscription token is present.
 */
export async function getClaudeUsageLimits(
  opts: UsageFetchOptions & { readToken?: CredentialReader } = {},
): Promise<ClaudeUsageLimits> {
  const readToken = opts.readToken ?? readClaudeOAuthToken;
  const token = await readToken();
  if (!token) return { available: false, reason: 'no_token' };
  return fetchClaudeUsageLimits(token, opts);
}
