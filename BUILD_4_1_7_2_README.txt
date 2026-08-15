Release 3.3 - Build 4.1.7.2
Archive reconstruction batch runner reliability patch.

Changes:
- Keeps one archived prop per Worker invocation to preserve Cloudflare subrequest safety.
- Browser now automatically chains 10 sequential Worker requests from one click.
- Adds Run all remaining for unattended sequential processing.
- Adds visible per-row batch progress and remaining count.
- Uses no-store API requests and a versioned JS asset URL to avoid stale browser/Cloudflare asset cache.
- No database migration.
- No model logic changes.
- No production v13 changes.
