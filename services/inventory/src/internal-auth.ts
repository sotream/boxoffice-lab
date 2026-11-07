import { INTERNAL_AUTH_HEADER, INTERNAL_AUTH_MAX_BODY, installInternalAuth as install, verifyInternalRequest } from "@boxoffice/platform";

export { INTERNAL_AUTH_HEADER };

/**
 * Inventory authenticates its callers with the shared hooks of packages/platform/src/internal-auth.ts (two hooks before the body is
 * parsed, probe paths open, everything else denied by default). What is accepted is decided here: `secrets` are the current key of
 * `INVENTORY_INTERNAL_TOKEN` and, during a rotation, the previous one; the signature is checked against the exact received body.
 */
export function installInternalAuth(app: Parameters<typeof install>[0], secrets: string[]): void {
  install(app, {
    verify: (header, method, path, body) => verifyInternalRequest(header, secrets, method, path, body),
    maxBodyBytes: INTERNAL_AUTH_MAX_BODY
  });
}
