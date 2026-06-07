// Decides whether a child's failure reason is "transient" (likely to clear on retry).
// Rate limits, overload, timeouts, network blips, 5xx, connection resets, etc. are transient.
// Deterministic errors like bad arguments / auth failure / missing model return false (retrying fails the same way).
//
// Why a separate module: index.ts uses a class parameter property, which can't be imported
// under node's strip-only execution (harness). This pure function is split out so it stays testable.
export function isTransientError(error: string | undefined): boolean {
  if (!error) return false;
  const e = error.toLowerCase();
  // Don't retry deterministic errors.
  if (
    /unknown option|invalid (model|argument|input)|no such|not found|unauthorized|forbidden|401|403|invalid api key|missing api key/.test(
      e,
    )
  ) {
    return false;
  }
  return /rate.?limit|429|overload|capacity|too many requests|timeout|timed out|etimedout|econnreset|econnrefused|enetunreach|socket hang up|network|temporarily|unavailable|503|502|504|500|server error|stream (error|closed)|reset by peer/.test(
    e,
  );
}
