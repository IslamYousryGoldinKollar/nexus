/**
 * Budget circuit-breaker primitives.
 *
 * The Phase 3/4 inngest functions already check `isOverMonthlyBudget`
 * inline. This module centralizes the *config* — the per-service USD
 * caps — so we don't sprinkle env-var reads across handlers.
 *
 * If a budget cap is exceeded, the caller's policy is up to them:
 *   - transcribe: skip + log (no business value lost; user can retry next month)
 *   - reason: mark session error + alert admin via Telegram
 *   - injaz: never breaks; we never want to skip an approved task
 */

export type BudgetService = 'anthropic' | 'openai_whisper' | 'assemblyai' | 'resend';

export interface BudgetConfig {
  monthlyUsd: number;
  alertThresholdPct: number; // 0..1 — alert at 80% by default
}

const DEFAULT_BUDGETS: Record<BudgetService, BudgetConfig> = {
  anthropic: { monthlyUsd: 200, alertThresholdPct: 0.8 },
  openai_whisper: { monthlyUsd: 100, alertThresholdPct: 0.8 },
  assemblyai: { monthlyUsd: 50, alertThresholdPct: 0.8 },
  resend: { monthlyUsd: 20, alertThresholdPct: 0.9 },
};

const ENV_KEY: Record<BudgetService, string> = {
  anthropic: 'ANTHROPIC_MONTHLY_BUDGET_USD',
  openai_whisper: 'WHISPER_MONTHLY_BUDGET_USD',
  assemblyai: 'ASSEMBLYAI_MONTHLY_BUDGET_USD',
  resend: 'RESEND_MONTHLY_BUDGET_USD',
};

export function getBudget(service: BudgetService): BudgetConfig {
  const raw = process.env[ENV_KEY[service]];
  const parsed = raw ? Number(raw) : NaN;
  const monthlyUsd = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BUDGETS[service].monthlyUsd;
  return { ...DEFAULT_BUDGETS[service], monthlyUsd };
}

/** Compute remaining budget + status given current spend. */
export function evaluateBudget(
  service: BudgetService,
  spentUsd: number,
): {
  service: BudgetService;
  budgetUsd: number;
  spentUsd: number;
  remainingUsd: number;
  status: 'ok' | 'warn' | 'exceeded';
} {
  const cfg = getBudget(service);
  const remainingUsd = Math.max(0, cfg.monthlyUsd - spentUsd);
  const status: 'ok' | 'warn' | 'exceeded' =
    spentUsd >= cfg.monthlyUsd ? 'exceeded'
    : spentUsd >= cfg.monthlyUsd * cfg.alertThresholdPct ? 'warn'
    : 'ok';
  return {
    service,
    budgetUsd: cfg.monthlyUsd,
    spentUsd,
    remainingUsd,
    status,
  };
}
