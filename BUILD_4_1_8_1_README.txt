MLB K-Prop Release 3.3 - Build 4.1.8.1
Archive Reconstruction Transient-Error Resilience

Purpose
- Keep the Build 4.1.8 expanded historical archive unchanged.
- Make long archive reconstruction batches tolerate transient Cloudflare/edge failures.
- Retry HTTP 429/500/502/503/504 and Cloudflare 52x responses with exponential backoff.
- Retry network-level fetch failures.
- After a failed POST, refresh status before retrying so a row that committed before the response failed is not blindly replayed.
- Slow successful sequential requests to one per second and refresh the full status table every five rows to reduce request pressure.
- Production v13, production props, native feature snapshots, and production predictions are untouched.
- No D1 migration is required.
