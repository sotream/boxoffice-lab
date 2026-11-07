/** Minimum distance between the sweeper's age threshold and the longest pre-charge check (ADR 007). */
export const SWEEP_MARGIN_MS = 500;

/**
 * ADR 007: a payment is inserted as PENDING and the request path asks inventory "who holds the seats?" before charging. If that
 * question outlasts the sweeper's age threshold, the sweeper picks the row up, charges it, and the request path then fails it on "not held".
 * The question is bounded twice, by the HTTP abort (CONFIRM_TIMEOUT_MS) and by `within` (PSP_TIMEOUT_MS, the service's single step
 * timeout), so it ends after at most the smaller of the two. The PSP and confirm steps that follow a positive answer are not part of this
 * race: a second runner there is harmless (idempotent PSP, compare-and-set transitions). Returns the problem, or undefined when the margin holds.
 * With the check switched off (VERIFY_HOLDS=0) there is nothing to race, so nothing is enforced.
 */
export function sweepMarginProblem(o: { sweepMinAgeMs: number; confirmTimeoutMs: number; pspTimeoutMs: number; verifyHolds: boolean }): string | undefined {
  if (!o.verifyHolds) return undefined;
  const checkBound = Math.min(o.confirmTimeoutMs, o.pspTimeoutMs);
  const need = checkBound + SWEEP_MARGIN_MS;
  if (o.sweepMinAgeMs >= need) return undefined;
  return `SWEEP_MIN_AGE_MS (${o.sweepMinAgeMs}) must be at least ${need}: the pre-charge check can take up to min(CONFIRM_TIMEOUT_MS, PSP_TIMEOUT_MS) = ${checkBound} ms, plus a ${SWEEP_MARGIN_MS} ms margin, or the sweeper can charge a payment that the request path then fails as "not held" (ADR 007)`;
}
