# Set up your own private Muninn

Give an agent this repository and ask it to deploy a new owner-private ChatGPT Site.
Every installation must use separate Site identity, database, storage, and credentials.

1. Keep the public development clone on `main`. `.openai/hosting.json`, `.sites-checkout`,
   `.local/`, credentials, photos, generated outputs, and machine configuration are ignored.
   Never commit installation identity to the public repository, including historical commits.
2. Read the installed Sites skill. Create one new private Site, persist its exact ID in a
   **separate** private source checkout under `.local/sites-source/`, and open that source
   with Sites' `site-workflow.mjs` helper. Do not open private Site history into the public clone.
   The private manifest declares `project_id` and the logical bindings `d1: "DB"`, `r2: "BUCKET"`.
3. Read back the Site access policy: current role owner, custom access, exactly the owner,
   zero external visitors, editors, workspace groups, or tenant groups. Keep it private.
4. Configure hosted secrets `OWNER_EMAIL` from the verified owner's account, `APP_ORIGIN`
   from the exact Sites origin, and `MACHINE_TOKEN_SHA256` as SHA-256 of a newly generated
   cryptographically random app credential. Keep the raw app credential only in your secret
   manager. Do not put runtime values in hosting metadata or environment files.
5. Obtain the Site's gateway bearer token using supported Sites service access. Store it
   with the app credential and pinned origin in your chosen encrypted credential provider.
   Both are required; the gateway credential supplies no owner identity. Never expose the
   Worker directly without Sites' authenticated dispatcher.
6. Run `npm ci` and `npm run check`. Commit generic source and push `main`. Require a clean
   public clone exactly equal to `origin/main`, then run `npm run site:sync-source --
--public-checkout` with the absolute public path and `--site-checkout` with the distinct
   private source path. This imports the complete public tree while preserving the private
   manifest and source history. Never merge the private history into public development.
7. From the returned private checkout, use the official Sites helper to push/package the
   source, running `npm ci` and `npm run check` if not already complete. Supply temporary
   credentials only through hidden stdin. Save and deploy that exact commit using the
   owner-private deployment operation. Wait for success, then re-read access and verify
   unauthenticated root, metadata and upload requests do not expose application data.
8. Install `scripts/muninn.py` on every agent host. Create a private JSON configuration at
   `~/.config/muninn/client.json` with these keys:

   - `origin`: your exact deployed HTTPS origin, without a trailing slash;
   - `environment`: your actual T3 environment ID;
   - `credential_command`: an argument array for your encrypted provider;
   - `cache_directory`: an absolute owner-private directory outside Git repositories.

   The provider prints a JSON object with `origin`, `gateway_token`, and `app_token` to
   its stdout. The client captures that output in memory. No particular secret manager is
   required. Credentials must never be passed in process arguments or stored in plaintext.

9. Create a session using `python3 scripts/muninn.py --thread "$T3CODE_THREAD_ID" new
--label "Photo capture"`. Share the returned URL in that chat. Run `wait` with the
   returned session ID and the same environment/thread. `fetch` performs one nonblocking
   check and resumes interrupted downloads. All operations reject cross-thread binding.
   Inspect every returned local image with your agent's image viewer.
10. Arrange daily `maintain` (or separate `cleanup` and `prune` jobs) to remove remote sessions after 24 hours, and `prune` to
    remove local completed cache directories after seven days. Use the host's normal
    script scheduler. Session creation also runs bounded remote cleanup opportunistically.
    Repeat standalone cleanup while its response says `more`. `maintain` handles pagination
    and invokes the configured `alert_command` argument array once on failure, appending a
    concise notification message. Configure that command and optional `maintenance_label`
    in the private client configuration. Failed cleanup must be surfaced.

Capture accepts photos for 30 minutes. Done sessions remain retrievable until 24 hours
after creation; acknowledgement immediately deletes R2 bytes while metadata remains until
cleanup. A failed download is never acknowledged. Losing the local cache after successful
acknowledgement loses the delivered images. Copy anything you need to retain elsewhere.

Test with at least two photos in each target harness. Confirm there are no new camera-roll
items on the physical phone, that Done wakes the waiting agent with no typed follow-up,
that expired links reject writes, and that acknowledgement deletes R2 bytes. Synthetic
tests cannot establish physical iPhone behavior or harness background completion behavior.
