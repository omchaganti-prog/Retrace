/**
 * Types for the Node-side strategist, so vite.config.ts can import it without
 * dragging the server file itself into the TypeScript program.
 */

export interface StrategyPayload {
  memory?: unknown;
  knowledge?: number;
  objectivesComplete?: string[];
  nextObjective?: string | null;
  lockdown?: boolean;
  zones?: string[];
  hideSpots?: string[];
}

/** Which vendor answered. Mirrors `Strategy["source"]` on the client. */
export type StrategySource = "claude" | "openai";

export interface PlannedStrategy {
  source: StrategySource;
  patrolZones: string[];
  guardZone: string | null;
  searchSpots: string[];
  echoSkepticism: number;
  aggression: number;
  taunt: string;
  rationale: string;
}

export type StrategyResult =
  | { ok: true; strategy: PlannedStrategy }
  | { ok: false; reason: string; detail?: string };

export function planStrategy(
  payload: StrategyPayload,
  env?: Record<string, string | undefined>,
): Promise<StrategyResult>;

/** Which provider the endpoint would use right now, or null if keyless. */
export function activeProvider(
  env?: Record<string, string | undefined>,
): "anthropic" | "openai" | null;

/** Connect-style handler; resolves once the response has been written. */
export function strategyMiddleware(
  env?: Record<string, string | undefined>,
): (req: unknown, res: unknown) => Promise<void>;
