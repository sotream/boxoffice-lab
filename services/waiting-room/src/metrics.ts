import { counter, gauge } from "@boxoffice/platform";
import type { QueueService } from "./queue.service";

/** result: queued (placed in line) | already_admitted. */
export const joins = counter("waitingroom_joins_total", "Queue join calls by result.", ["result"]);
export const admitted = counter("waitingroom_admitted_total", "Users moved from the queue to admitted.");
export const admissionErrors = counter("waitingroom_admission_errors_total", "Admission ticks that failed (for example Redis unreachable).");

/** Queue length of the event the admission tick serves, read from Redis at scrape time. No event label: the tick serves one event. */
export function registerQueueLengthGauge(q: QueueService, eventId: number): void {
  gauge("waitingroom_queue_length", "Users waiting in the queue of the admitted event.", [], async function () {
    try { this.set(await q.length(eventId)); } catch { /* Redis down: keep the last value, the readiness probe reports it */ }
  });
}
