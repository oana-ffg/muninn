# Muninn

Send a look from your phone to the chat that asked for it.

An agent creates an expiring capture link. Open it in Safari, enable the in-page camera,
take photos, remove any you do not want, and tap **Done**. The waiting agent downloads
and verifies every JPEG, acknowledges delivery, and the service deletes the remote bytes.
The camera uses `getUserMedia` and canvas rather than the iOS camera application. Physical
iPhone verification is required to confirm camera-roll behavior on your iOS version.

Each installation has its own owner-private ChatGPT Site, D1 database and R2 bucket.
There is no shared hosted service. The Python client uses only the standard library and
works independently of the agent provider. T3 thread binding is explicit; there are no
global chat hooks, broadcasts, scheduled agent wakeups, or paid model API calls.

See [HOW_TO_SET_UP.md](HOW_TO_SET_UP.md) for deployment and client configuration,
[SECURITY.md](SECURITY.md) for trust boundaries, and [examples/pic/SKILL.md](examples/pic/SKILL.md)
for an example agent workflow.

Development: `npm ci`, `npm run db:generate` for schema changes, `npm run check`.
Tests use isolated local D1/R2 and synthetic bytes. The portable build does not need a
private hosting manifest. Publication does.
