import { counter, gauge } from "@boxoffice/platform";

/** channel: email | push. One increment per (event, channel) actually handed to the provider and recorded SENT. */
export const delivered = counter("notifications_delivered_total", "Notifications delivered, by channel.", ["channel"]);
/** Redelivered messages whose (event, channel) was already SENT: the at-least-once pipeline's duplicates, suppressed by the dedup key. */
export const duplicatesSuppressed = counter("notifications_duplicate_suppressed_total", "Duplicate deliveries suppressed by the per-channel dedup key.", ["channel"]);
export const dlq = counter("notifications_dlq_total", "Messages published to the dead-letter topic.");
/** Remaining messages in a partition after the last processed batch (0 when caught up; not updated while no batches arrive). */
export const consumerLag = gauge("notifications_consumer_lag_messages", "Consumer lag per partition as of the last processed batch.", ["partition"]);
