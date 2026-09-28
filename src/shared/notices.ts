/** A standing notice the UI shows as an alert. */
export interface Notice {
  id: "wrangler-dev-writes";
  message: string;
}

/**
 * S3 (01-T10): workerd doesn't wait on SQLite locks, so a Worker write that
 * overlaps a studio write fails with SQLITE_BUSY. Reads from the studio never
 * do this, so the notice is for local write mode only.
 */
export const WRANGLER_DEV_WRITES: Notice = {
  id: "wrangler-dev-writes",
  message:
    "If `wrangler dev` is running, a Worker write that overlaps a studio write fails with SQLITE_BUSY. Reads are safe, and nothing is corrupted.",
};
