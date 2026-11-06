import { createLogger, Logger, setRootLogger } from "./logger";
import { initMetrics } from "./metrics";

/** One call at the top of main(): names the process for logs and metrics and sets the default logger. */
export function initService(name: string): Logger {
  const logger = createLogger({ service: name });
  setRootLogger(logger);
  initMetrics(name);
  return logger;
}
