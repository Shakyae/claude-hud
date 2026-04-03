import type { UsageData } from './types.js';
export type { UsageData } from './types.js';
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
export declare const USAGE_API_USER_AGENT = "claude-code/2.1";
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
/**
 * Check if the configured base URL points to a MiniMax endpoint.
 */
export declare function isMinimaxEndpoint(env?: NodeJS.ProcessEnv): boolean;
/**
 * Get OAuth usage data from Anthropic API.
 * Returns null if user is an API user (no OAuth credentials) or credentials are expired.
 * Returns { apiUnavailable: true, ... } if API call fails (to show warning in HUD).
 *
 * Uses in-memory cache since HUD runs as a new process each render (~300ms).
 */
export declare function getUsage(overrides?: Partial<UsageApiDeps>): Promise<UsageData | null>;
export declare function getUsageApiTimeoutMs(env?: NodeJS.ProcessEnv): number;
export declare function clearCache(_homeDir?: string): void;
//# sourceMappingURL=usage-api.d.ts.map