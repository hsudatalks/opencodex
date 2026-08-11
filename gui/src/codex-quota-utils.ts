export interface AccountQuota {
  weeklyPercent?: number;
  fiveHourPercent?: number;
  monthlyPercent?: number;
  weeklyResetAt?: number;
  fiveHourResetAt?: number;
  monthlyResetAt?: number;
  customWindows?: { label: string; percent: number; resetAt?: number }[];
  resetCredits?: number;
  /** Nearest future manual-reset credit expiry, in epoch seconds. */
  resetCreditExpiresAt?: number;
  updatedAt: number;
}

export function isThirtyDayOnlyPlan(plan: string | null | undefined): boolean {
  const normalized = plan?.trim().toLowerCase();
  return normalized === "go" || normalized === "free";
}

export function normalizeQuotaForPlan(quota: AccountQuota | null, plan: string | null | undefined): AccountQuota | null {
  if (!quota || !isThirtyDayOnlyPlan(plan)) return quota;
  return {
    ...(quota.monthlyPercent !== undefined ? { monthlyPercent: quota.monthlyPercent } : {}),
    ...(quota.monthlyResetAt !== undefined ? { monthlyResetAt: quota.monthlyResetAt } : {}),
    ...(quota.resetCredits !== undefined ? { resetCredits: quota.resetCredits } : {}),
    ...(quota.resetCreditExpiresAt !== undefined ? { resetCreditExpiresAt: quota.resetCreditExpiresAt } : {}),
    updatedAt: quota.updatedAt,
  };
}
