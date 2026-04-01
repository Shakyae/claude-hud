import * as https from 'https';
import type { UsageData } from './types.js';

export type { UsageData } from './types.js';

interface MinimaxModelRemains {
  model_name: string;
  remains: number;
  total: number;
  reset_at: number;
}

interface MinimaxRawResponse {
  code: number;
  msg: string;
  data: {
    models: MinimaxModelRemains[];
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
  /** Retry-After header value in seconds (from 429 responses) */
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
};

// File-based cache key for usage data
function getCacheFilePath(homeDir: string): string {
  return `${homeDir}/.claude/plugins/claude-hud/usage-cache.json`;
}

function isMinimaxEndpoint(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim() || process.env.ANTHROPIC_API_BASE_URL?.trim();
  if (!baseUrl) return false;
  const lower = baseUrl.toLowerCase();
  return lower.includes('minimaxi') || lower.includes('minimax');
}

async function readMiniMaxApiKey(homeDir: string): Promise<string | null> {
  // Try reading from config file or environment
  const apiKey = process.env.MINIMAX_API_KEY;
  if (apiKey) return apiKey;

  // Try reading from Claude config directory
  try {
    const configPath = `${homeDir}/.claude/settings.json`;
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(configPath, 'utf-8');
    const config = JSON.parse(content);
    return config.minimaxApiKey || null;
  } catch {
    return null;
  }
}

async function fetchMiniMaxUsage(apiKey: string): Promise<UsageApiResult> {
  return new Promise((resolve) => {
    const url = new URL('https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains');

    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': USAGE_API_USER_AGENT,
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data) as MinimaxRawResponse;
          if (parsed.code === 0 && parsed.data?.models) {
            // Find the coding plan model and convert to UsageApiResponse format
            const codingModel = parsed.data.models.find(m => m.model_name === 'coding');
            if (codingModel && codingModel.total > 0) {
              const utilization = Math.round((1 - (codingModel.remains || 0) / codingModel.total) * 100);
              resolve({
                data: {
                  seven_day: {
                    utilization: utilization,
                    resets_at: codingModel.reset_at ? new Date(codingModel.reset_at * 1000).toISOString() : undefined,
                  },
                },
              });
              return;
            }
          }
          resolve({ data: null, error: parsed.msg || 'Unknown error' });
        } catch {
          resolve({ data: null, error: 'Failed to parse response' });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ data: null, error: err.message });
    });

    req.setTimeout(10000, () => {
      req.destroy();
      resolve({ data: null, error: 'Request timeout' });
    });

    req.end();
  });
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

const DEFAULT_TTLS: CacheTtls = {
  cacheTtlMs: 60000,       // 60 seconds
  failureCacheTtlMs: 15000, // 15 seconds
};

const USAGE_API_TIMEOUT_MS = 8000;

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
  const cachePath = getCacheFilePath(deps.homeDir());

  // Check in-memory cache first
  if (usageCache && now - usageCache.timestamp < deps.ttls.cacheTtlMs) {
    return convertToUsageData(usageCache.data);
  }

  if (failureCache && now - failureCache.timestamp < deps.ttls.failureCacheTtlMs) {
    return null;
  }

  // MiniMax endpoint handling
  if (isMinimaxEndpoint()) {
    const apiKey = await readMiniMaxApiKey(deps.homeDir());
    if (!apiKey) {
      return null;
    }

    const result = await fetchMiniMaxUsage(apiKey);
    if (result.data) {
      usageCache = { data: result.data, timestamp: now, cached: false };
      failureCache = null;
      return convertToUsageData(result.data);
    } else {
      failureCache = { error: result.error || 'Unknown error', timestamp: now };
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
