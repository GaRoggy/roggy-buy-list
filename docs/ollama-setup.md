# Private local AI setup

Roggy Lists stays a static GitHub Pages PWA. The browser never calls Ollama directly. A small Node service on the Windows PC validates the signed-in Supabase session, checks the owner UUID, and then calls Ollama on loopback:

```text
Roggy Lists (GitHub Pages)
  -> HTTPS through Tailscale Serve (tailnet only)
  -> 127.0.0.1:8787 Roggy AI bridge
  -> Supabase Auth /auth/v1/user (owner check)
  -> 127.0.0.1:11434 Ollama /api/tags, /api/show, /api/chat
```

The bridge does not use a Supabase service-role key and does not store conversations. It sends the browser's bearer token to Supabase Auth for remote verification on every request. It rejects every user except the configured owner UUID, rejects anonymous users, limits request size/frequency/concurrency, enforces timeouts, and logs only request IDs, durations, and safe error codes. Ollama is never bound to a Tailscale address, LAN address, or public internet address.

## One-time PC setup

1. Install Node.js 24 LTS, Ollama for Windows, Tailscale for Windows, and Git. Sign in to the same Tailscale account on the PC and on each phone/tablet/browser device that should use local AI. Keep the tailnet ACL limited to your own devices.

2. In the repository root, copy the example configuration and edit it in a local editor:

   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```

   Fill in:

   - `SUPABASE_URL=https://dplvxsniyqkwlmdzqbyg.supabase.co`
   - `SUPABASE_ANON_KEY` with the existing browser publishable key from the Supabase project settings. This is an anon/publishable key, never a `service_role` or secret key.
   - `OLLAMA_ALLOWED_USER_ID=9c1fcb62-644b-486a-9f87-36246e2e50de` (the existing owner UUID in `app.js`)
   - `OLLAMA_BASE_URL=http://127.0.0.1:11434`
   - `OLLAMA_ALLOWED_ORIGINS=https://garoggy.github.io`

   Leave `OLLAMA_BRIDGE_URL` blank until Tailscale Serve prints the PC's private HTTPS name. `.env` is ignored by Git. Never paste it into chat, commit it, or put it in frontend code.

3. Confirm Ollama is running and only reachable on loopback:

   ```powershell
   (Invoke-RestMethod http://127.0.0.1:11434/api/tags).models | Select-Object name
   netstat -ano | Select-String ':11434'
   ```

   The listener should be local. Do not set `OLLAMA_HOST=0.0.0.0`, open Windows Firewall for 11434, port-forward 11434 on the router, or use Tailscale Funnel.

4. Start the bridge in a PowerShell window and leave it running while testing:

   ```powershell
   npm run ollama-bridge
   ```

   It must print a `bridge_ready` event on `127.0.0.1:8787`. A second bridge process will fail rather than silently replacing the first one.

5. Publish the bridge privately with Tailscale Serve. The current Tailscale CLI can proxy the local port and automatically provision tailnet HTTPS:

   ```powershell
   tailscale serve 8787
   tailscale serve status
   ```

   Use the `https://PC-NAME.TAILNET.ts.net` URL printed as the `OLLAMA_BRIDGE_URL` value. Serve is private to the tailnet; do not run `tailscale funnel`. If your client requires an explicit background flag, use `tailscale serve --bg 8787`. `tailscale serve status` should show a proxy to `http://127.0.0.1:8787`.

6. Set the private URL in `.env`, then generate the browser's endpoint configuration and build the existing PWA:

   ```powershell
   # Example only; use the exact URL shown by Tailscale.
   # OLLAMA_BRIDGE_URL=https://my-pc.my-tailnet.ts.net
   npm run ai:configure
   npm run build
   ```

   `ai-config.js` contains only that public Tailscale hostname. It contains no token or key. Deploy the same existing static files (`dist/`) to the Roggy Lists GitHub Pages branch using your normal deployment workflow.

## Start automatically with Windows

First run the bridge in the foreground and complete a live test. Then register the startup task using the same Windows account that runs Ollama and Tailscale:

```powershell
.\ai\windows\install.ps1 -NodePath 'C:\Program Files\nodejs\node.exe'
```

The task runs the bridge at startup, restarts it after failures, and writes safe logs under `logs/`. It does not save a password in the repository. Ollama and Tailscale still need their own normal Windows startup behavior. Inspect `Roggy Local AI` in Task Scheduler after reboot:

```powershell
Get-ScheduledTask -TaskName 'Roggy Local AI'
Get-Content logs\ai-*.log -Tail 30
```

To stop or remove the task:

```powershell
Stop-ScheduledTask -TaskName 'Roggy Local AI'
Unregister-ScheduledTask -TaskName 'Roggy Local AI'
```

## Use it from iPhone or another device

Install Tailscale on the device, sign in to the same tailnet, and keep Tailscale connected. Open the normal Roggy Lists URL in Safari. Sign in with the authorized GitHub/Supabase account, open **More → Local AI**, and choose **Reconnect / refresh**. The page should show `Ollama online · private` and list the locally installed models. A device outside the tailnet will show an offline message and cannot reach the bridge.

The first Safari request may ask to allow access to devices on the local network. Allow it for the Roggy Lists site. The website still requires Supabase authentication even when the device is already on Tailscale. Signing out immediately clears the chat and prevents model discovery or generation.

## Troubleshooting

- `Setup needed`: run `npm run ai:configure` after setting a real `.ts.net` `OLLAMA_BRIDGE_URL`, rebuild, and deploy the existing site.
- `Cannot reach your PC`: check Tailscale status on both devices, `tailscale ping PC-NAME`, `tailscale serve status`, the bridge log, and that Windows did not suspend the PC.
- `The bridge is reachable, but Ollama is offline`: start Ollama and verify `http://127.0.0.1:11434/api/tags` locally on the PC.
- `This account is not authorized`: the signed-in Supabase user ID does not equal `OLLAMA_ALLOWED_USER_ID`; update the local configuration only if the account is intentionally changed.
- `No local models`: install a model with Ollama, then refresh. Cloud aliases and remote models are intentionally excluded.
- If the website was recently deployed, refresh the service worker once. The cache is versioned `v42`.

## Validation commands

From the repository root:

```powershell
npm test
npm run build
node monitor/test/browser.mjs C:\path\to\playwright\index.mjs
```

The AI tests use synthetic Supabase/Ollama responses and verify unauthorized access, owner checks, origin/host checks, request limits, streamed chat, model discovery, offline behavior, cancellation, timeouts, logging redaction, and cloud-model rejection. They do not contact your production Supabase project or send real prompts.

## Extension boundary

`ai/providers/` contains provider adapters, `ai/processing.mjs` owns provider-neutral text processing, and the bridge owns transport/authentication. Future local collectors (Whisper, notifications, files, health data, or monitoring records) can submit bounded text to this processing layer without coupling their storage or collection code to Ollama. No collector is connected today, and there is no automatic cloud-provider fallback. Adding OpenAI later should be a new provider adapter plus an explicit routing decision; it should not silently send local data off the PC.
