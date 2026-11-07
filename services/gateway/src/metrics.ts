import { counter, histogram } from "@boxoffice/platform";

/** limiter: ip | user. decision: allowed | limited | fail_open | fail_closed. */
export const limiterDecisions = counter("gateway_limiter_decisions_total", "Rate limiter outcomes by limiter and decision (fail_open/fail_closed = limiter store unreachable).", ["limiter", "decision"]);
/** upstream: inventory | queue | payments. reason: timeout | unreachable. */
export const upstreamErrors = counter("gateway_upstream_errors_total", "Upstream calls that ended in a 504 (timeout or unreachable).", ["upstream", "reason"]);
export const upstreamDuration = histogram("gateway_upstream_duration_seconds", "Time spent waiting for the upstream service.", ["upstream"]);
export const admissionRejected = counter("gateway_admission_rejected_total", "Hold, confirm and pay requests refused for a missing or invalid admission token, or whose body user is not the token's user.");
