/**
 * Cline CLI headers to identify as official Cline product surface.
 * Required by Cline API to access free-tier models (DeepSeek, Solar, Muse, etc.).
 *
 * @module clinepass-headers
 */

export const CLINE_CLI_VERSION = "3.0.61";

export function buildClineCliHeaders(): Record<string, string> {
  return {
    "x-client-type": "cli",
    "x-client-version": CLINE_CLI_VERSION,
    "x-core-version": CLINE_CLI_VERSION,
    "x-platform": process.platform,
    "user-agent": `Cline/${CLINE_CLI_VERSION}`,
  };
}
