import { counter } from "@boxoffice/platform";

/** strategy: atomic-update | for-update. result: ok | conflict (seats taken, a normal business outcome) | error (unexpected failure). */
export const holds = counter("inventory_holds_total", "Seat hold attempts by locking strategy and result.", ["strategy", "result"]);
/** result: ok | conflict | error. */
export const confirms = counter("inventory_confirms_total", "Seat confirm attempts by result.", ["result"]);
