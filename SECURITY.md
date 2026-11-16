# Security model

The Site gateway and application both authorize requests. Browser capture requires the
dispatcher-authenticated owner ID plus the configured owner email. Machine creation and
cleanup require a separately generated app credential in addition to the Sites gateway
token. A session delivery credential is HMAC-SHA256 of its random ID, environment and
thread using the app credential. The server stores only that credential's SHA-256 hash.
The same app credential must remain available while a delivery is pending. Rotate it
only when pending sessions have been handled. Delivery credentials never enter URLs or
files. The URL selects a session; it is not authorization.

A delivery credential can read/acknowledge only its own session with the exact stored
environment and thread. It cannot create sessions, upload photos, finish capture, or run
cleanup. The installation's master app credential can create sessions for any destination
and run retention cleanup, so restrict it to trusted agent machines. There is no protection
against an authorized agent deliberately lying about its environment/thread at creation.

Browser writes reject other origins; no CORS grant is issued. Replies are never cached.
Photos are limited to twenty JPEGs of at most 8 MiB each. The camera converts frames to
JPEG before upload, which excludes HEIC and device photo metadata. No camera-roll API or
file picker is used. Preview images and unsent frames exist only in page memory; closing
or reloading the page loses them. A network failure retains selected photos while the page
stays open, and deterministic photo IDs make upload retries idempotent.

The Python client pins the credential origin, refuses redirects, binds each session to
the calling chat, verifies size and SHA-256, saves atomically with owner-only permissions,
and fsyncs files before acknowledgement. Remote deletion is retryable. There is no model
or third-party image processing service. Local downloads live outside Git repositories.

Do not deploy the Worker directly to an unrestricted workers.dev endpoint: identity
headers are trustworthy only behind Sites' dispatcher. Hosting infrastructure retains
administrative access. A private Site is not end-to-end encrypted storage.
