import { outgoingHeaders } from "@boxoffice/platform";
import { ConfirmSeats, StepTimeout } from "./payments.service";

/**
 * Confirm seats at inventory over HTTP and map the answer to what the saga needs:
 *  - 2xx: the seats are sold to this user (true);
 *  - 409: inventory says the hold is missing or expired, the one answer that justifies a refund (false);
 *  - 5xx, timeout, unreachable: the outcome is unknown, so StepTimeout (never a refund, retried later);
 *  - any other 4xx (400, 404, ...): a contract bug on our side. It must not turn into a refund of a valid payment and must
 *    not be retried as if it were slow, so it throws a plain Error: the saga stays CHARGED and the sweeper reports it every run.
 */
export function confirmSeatsOverHttp(inventoryUrl: string, timeoutMs: number): ConfirmSeats {
  return async (eventId, seatIds, userId) => {
    let res: Response;
    try {
      res = await fetch(`${inventoryUrl}/events/${eventId}/confirm`, {
        method: "POST", headers: { "content-type": "application/json", ...outgoingHeaders() }, body: JSON.stringify({ seatIds, userId }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch {
      throw new StepTimeout("inventory unreachable or timed out");
    }
    if (res.status >= 500) throw new StepTimeout(`inventory ${res.status}`); // unknown outcome, not "seats lost"
    if (res.ok) return true;
    if (res.status === 409) return false;
    throw new Error(`inventory rejected the confirm request with ${res.status}`);
  };
}
