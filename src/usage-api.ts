import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'https';
import { getClaudeConfigDir, getHudPluginDir } from './claude-config-dir.js';
import type { UsageData } from './types.js';

export type { UsageData } from './types.js';

const debug = createDebug('usage');

function createDebug(namespace: string) {
  return (...args: unknown[]) => {
    if (process.env.DEBUG?.includes('hud')) {
      console.log(`[${namespace}]`, ...args);
    }
  };
}

// File-based cache key for usage data
function getCacheFilePath(homeDir: string): string {
  return path.join(getHudPluginDir(homeDir), '.usage-cache.json');
}

function getCacheLockPath(homeDir: string): string {
  return path.join(getHudPluginDir(homeDir), '.usage-cache.lock');
}

interface MinimaxModelRemains {
  model_name?: string;
  current_interval_usage_count?: number;
  current_interval_total_count?: number;
  remains_time?: number; // milliseconds until reset
  current_weekly_usage_count?: number;
  weekly_total_count?: number;
  weekly_remains_time?: number; // milliseconds until weekly reset
}

interface MinimaxRawResponse {
  model_remains?: MinimaxModelRemains[];
  base_resp?: {
    status_code?: number;
    status_msg?: string;
  };
}

interface UsageApiResponse {
  five_hour?: {
    utilization?: number;
    resets_at?: string;
  };
  seven_day?: {
    utilization?: number;
    resets_at?: string;
  };
}

interface UsageApiResult {
  data: UsageApiResponse | null;
  error?: string;
  retryAfterSec?: number;
}

export const USAGE_API_USER_AGENT = "claude-code/2.1";

type CacheTtls = {
  cacheTtlMs: number;
  failureCacheTtlMs: number;
};

export type UsageApiDeps = {
  homeDir: () => string;
  fetchApi: (accessToken: string) => Promise<UsageApiResult>;
  now: () => number;
  readKeychain: (now: number, homeDir: string) => {
    accessToken: string;
    subscriptionType: string;
  } | null;
  ttls: CacheTtls;
  fetchMiniMaxApi?: (apiKey: string) => Promise<UsageApiResult>;
};

const DEFAULT_TTLS: CacheTtls = {
  cacheTtlMs: 60000,       // 60 seconds
  failureCacheTtlMs: 15000, // 15 seconds
};

const USAGE_API_TIMEOUT_MS = 8000;

/**
 * Check if the configured base URL points to a MiniMax endpoint.
 */
export function isMinimaxEndpoint(env: NodeJS.ProcessEnv = process.env): boolean {
  const baseUrl = env.ANTHROPIC_BASE_URL?.trim() || env.ANTHROPIC_API_BASE_URL?.trim();
  if (!baseUrl) return false;
  const lower = baseUrl.toLowerCase();
  return lower.includes('minimaxi') || lower.includes('minimax');
}

function parseUtilization(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(Math.min(100, Math.max(0, value)));
}

function parseDate(dateStr: string | undefined): Date | null {
  if (!dateStr) return null;
  try {
    const date = new Date(dateStr);
    return Number.isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

function readMiniMaxApiKey(homeDir: string): string | null {
  // Tier 1: ANTHROPIC_AUTH_TOKEN environment variable
  const fromAuthToken = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
  if (fromAuthToken) return fromAuthToken;

  // Tier 2: ANTHROPIC_API_KEY environment variable
  const fromApiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (fromApiKey) return fromApiKey;

  // Tier 3: settings.json env.ANTHROPIC_AUTH_TOKEN
  try {
    const settingsPath = path.join(getClaudeConfigDir(homeDir), 'settings.json');
    if (!fs.existsSync(settingsPath)) return null;
    const content = fs.readFileSync(settingsPath, 'utf8');
    const settings = JSON.parse(content);
    const envToken = settings?.env?.ANTHROPIC_AUTH_TOKEN?.trim();
    return envToken || null;
  } catch {
    return null;
  }
}

function fetchMiniMaxUsage(apiKey: string): Promise<UsageApiResult> {
  return new Promise((resolve) => {
    const timeoutMs = USAGE_API_TIMEOUT_MS;
    const options = {
      hostname: 'www.minimaxi.com',
      path: '/v1/api/openplatform/coding_plan/remains',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': USAGE_API_USER_AGENT,
      },
      timeout: timeoutMs,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          debug('MiniMax API returned non-200 status:', res.statusCode);
          const error = res.statusCode === 429 ? 'rate-limited' : `http-${res.statusCode}`;
          resolve({ data: null, error });
          return;
        }

        try {
          const raw: MinimaxRawResponse = JSON.parse(data);

          if (raw.base_resp && raw.base_resp.status_code !== 0) {
            debug('MiniMax API business error:', raw.base_resp.status_msg);
            resolve({ data: null, error: `minimax-${raw.base_resp.status_code}` });
            return;
          }

          const remains = raw.model_remains;
          if (!remains || remains.length === 0) {
            resolve({ data: null, error: 'minimax-empty' });
            return;
          }

          // Try to find the model matching ANTHROPIC_MODEL, or fall back to first entry
          const modelEnv = process.env.ANTHROPIC_MODEL?.trim()?.toLowerCase();
          const matched = modelEnv
            ? remains.find(r => r.model_name?.toLowerCase().includes(modelEnv))
            : undefined;
          const entry = matched ?? remains[0];

          const total = entry.current_interval_total_count ?? 0;
          const unused = entry.current_interval_usage_count ?? 0;
          const fiveHourUtil = total > 0 ? ((total - unused) / total) * 100 : 0;
          const fiveHourResetMs = entry.remains_time;
          const fiveHourResetAt = (fiveHourResetMs != null && fiveHourResetMs > 0)
            ? new Date(Date.now() + fiveHourResetMs).toISOString()
            : undefined;

          const weeklyTotal = entry.weekly_total_count ?? 0;
          const weeklyUnused = entry.current_weekly_usage_count ?? 0;
          const sevenDayUtil = weeklyTotal > 0 ? ((weeklyTotal - weeklyUnused) / weeklyTotal) * 100 : 0;
          const weeklyResetMs = entry.weekly_remains_time;
          const sevenDayResetAt = (weeklyResetMs != null && weeklyResetMs > 0)
            ? new Date(Date.now() + weeklyResetMs).toISOString()
            : undefined;

          const apiResponse: UsageApiResponse = {
            five_hour: { utilization: fiveHourUtil, resets_at: fiveHourResetAt },
            seven_day: { utilization: sevenDayUtil, resets_at: sevenDayResetAt },
          };

          resolve({ data: apiResponse });
        } catch (e) {
          debug('Failed to parse MiniMax API response:', e);
          resolve({ data: null, error: 'parse' });
        }
      });
    });

    req.on('error', (error) => {
      debug('MiniMax API request error:', error);
      resolve({ data: null, error: 'network' });
    });
    req.on('timeout', () => {
      debug('MiniMax API request timeout');
      req.destroy();
      resolve({ data: null, error: 'timeout' });
    });

    req.end();
  });
}

interface CacheState {
  data: UsageData;
  timestamp: number;
  isFresh: boolean;
}

function hydrateUsageData(data: UsageData): UsageData {
  // JSON.stringify converts Date to ISO string, so we need to reconvert on read.
  // new Date() handles both Date objects and ISO strings safely.
  if (data.fiveHourResetAt) {
    data.fiveHourResetAt = new Date(data.fiveHourResetAt as unknown as string);
  }
  if (data.sevenDayResetAt) {
    data.sevenDayResetAt = new Date(data.sevenDayResetAt as unknown as string);
  }
  return data;
}

function readCacheState(homeDir: string, now: number, ttls: CacheTtls): CacheState | null {
  try {
    const cachePath = getCacheFilePath(homeDir);
    if (!fs.existsSync(cachePath)) return null;

    const content = fs.readFileSync(cachePath, 'utf8');
    const cache = JSON.parse(content);

    const ttl = cache.data?.apiUnavailable ? ttls.failureCacheTtlMs : ttls.cacheTtlMs;
    return {
      data: hydrateUsageData(cache.data),
      timestamp: cache.timestamp,
      isFresh: now - cache.timestamp < ttl,
    };
  } catch {
    return null;
  }
}

function writeCache(homeDir: string, data: UsageData, now: number): void {
  try {
    const cachePath = getCacheFilePath(homeDir);
    const cache = { data, timestamp: now };
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    debug('Failed to write cache:', e);
  }
}

async function getMiniMaxUsage(
  homeDir: string,
  nowFn: () => number,
  ttls: CacheTtls,
  fetchFn?: (apiKey: string) => Promise<UsageApiResult>,
): Promise<UsageData | null> {
  const now = nowFn();
  const fetcher = fetchFn ?? fetchMiniMaxUsage;

  // Check cache first
  const cacheState = readCacheState(homeDir, now, ttls);
  if (cacheState?.isFresh) {
    return cacheState.data;
  }

  const apiKey = readMiniMaxApiKey(homeDir);
  if (!apiKey) {
    debug('MiniMax API key not found');
    return null;
  }

  const apiResult = await fetcher(apiKey);
  if (!apiResult.data) {
    const failureResult: UsageData = {
      planName: 'MiniMax',
      fiveHour: null,
      sevenDay: null,
      fiveHourResetAt: null,
      sevenDayResetAt: null,
      apiUnavailable: true,
      apiError: apiResult.error,
    };
    writeCache(homeDir, failureResult, now);
    return failureResult;
  }

  const fiveHour = parseUtilization(apiResult.data.five_hour?.utilization);
  const sevenDay = parseUtilization(apiResult.data.seven_day?.utilization);
  const fiveHourResetAt = parseDate(apiResult.data.five_hour?.resets_at);
  const sevenDayResetAt = parseDate(apiResult.data.seven_day?.resets_at);

  const result: UsageData = {
    planName: 'MiniMax',
    fiveHour,
    sevenDay,
    fiveHourResetAt,
    sevenDayResetAt,
  };

  writeCache(homeDir, result, now);
  return result;
}

let usageCache: {
  data: UsageApiResponse | null;
  timestamp: number;
  cached: boolean;
} | null = null;

let failureCache: {
  error: string;
  timestamp: number;
} | null = null;

const DEFAULT_IN_MEMORY_CACHE_TTL_MS = 60000;
const DEFAULT_IN_MEMORY_FAILURE_CACHE_TTL_MS = 15000;

/**
 * Get OAuth usage data from Anthropic API.
 * Returns null if user is an API user (no OAuth credentials) or credentials are expired.
 * Returns { apiUnavailable: true, ... } if API call fails (to show warning in HUD).
 *
 * Uses in-memory cache since HUD runs as a new process each render (~300ms).
 */
export async function getUsage(overrides?: Partial<UsageApiDeps>): Promise<UsageData | null> {
  const deps: UsageApiDeps = {
    homeDir: () => {
      const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
      return overrides?.homeDir?.() || home;
    },
    fetchApi: async () => ({ data: null }),
    now: () => Date.now(),
    readKeychain: () => null,
    ttls: DEFAULT_TTLS,
    ...overrides,
  };

  const now = deps.now();

  // Check in-memory cache first
  if (usageCache && now - usageCache.timestamp < DEFAULT_IN_MEMORY_CACHE_TTL_MS) {
    return convertToUsageData(usageCache.data);
  }

  if (failureCache && now - failureCache.timestamp < DEFAULT_IN_MEMORY_FAILURE_CACHE_TTL_MS) {
    return null;
  }

  // MiniMax has its own usage API — handle before the generic custom endpoint check
  if (isMinimaxEndpoint()) {
    debug('Detected MiniMax endpoint, using MiniMax usage API');
    const result = await getMiniMaxUsage(
      deps.homeDir(),
      deps.now,
      deps.ttls,
      deps.fetchMiniMaxApi,
    );

    if (result) {
      usageCache = { data: result as unknown as UsageApiResponse, timestamp: now, cached: false };
      failureCache = null;
      return result;
    } else {
      failureCache = { error: 'no-api-key', timestamp: now };
      return null;
    }
  }

  // Original Anthropic API handling would go here
  // For now, return null as we don't have the original implementation
  return null;
}

function convertToUsageData(response: UsageApiResponse | null): UsageData | null {
  if (!response) return null;

  return {
    fiveHour: response.five_hour?.utilization ?? null,
    sevenDay: response.seven_day?.utilization ?? null,
    fiveHourResetAt: response.five_hour?.resets_at ? new Date(response.five_hour.resets_at) : null,
    sevenDayResetAt: response.seven_day?.resets_at ? new Date(response.seven_day.resets_at) : null,
  };
}

export function getUsageApiTimeoutMs(env?: NodeJS.ProcessEnv): number {
  return USAGE_API_TIMEOUT_MS;
}

export function clearCache(_homeDir?: string): void {
  usageCache = null;
  failureCache = null;
}
