# TaxWise Desktop

The TaxWise CRM with WhatsApp Web beside it, for TaxWise Consultants' office PCs (SPEC §7.25).
**Open chat** on a client opens that client's WhatsApp group in a panel next to the client's page.
Employees work in **client mode**: they see only the chat opened from the CRM.

It is a separate Electron project. The web CRM works without it everywhere (§7.25.8).

```
desktop/
  src/main/        main process: window and views, navigation, permissions, IPC, desktop API client,
                   device key, context refresh, number rules, downloads, updates, menus
  src/preload/     crm.ts (window.taxwiseDesktop), whatsapp.ts (client mode), panel.ts (header)
  src/whatsapp/    selectors.ts (every WhatsApp Web selector), open-chat.ts, client-mode.ts, shield.ts
  src/renderer/    panel header (number switcher, client-mode chip, Pop out, Close, screens)
  src/shared/      config, types, typed IPC channels, user-facing copy
  scripts/         build.mjs (esbuild bundles), fuses.ts (electron-builder afterPack hook)
  tests/           Vitest unit tests; tests/fixtures/ holds WhatsApp Web page fixtures
  e2e/             Playwright Electron tests (CI, where the Electron binary is installed)
```

How it is put together: one `BaseWindow` with `WebContentsView`s (never `BrowserView`):

| View | Session | Loads |
|---|---|---|
| CRM (left) | `persist:crm` | `TAXWISE_APP_URL`, baked in at build time |
| WhatsApp panel (right), one per firm number | `persist:wa-<number_id>` | `https://web.whatsapp.com/` |
| Panel header and splitter | `taxwise-panel` (in memory) | `taxwise://panel/panel-header.html` from the app bundle |

Every decision (navigation, permissions, which numbers show, client mode, IPC senders, layout, downloads)
is a pure module with unit tests; the Electron files only apply them.

## Develop

```bash
cd desktop
npm install                 # in CI without the Electron binary: ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install
npm run typecheck
npm test                    # Vitest, no Electron needed
TAXWISE_APP_URL=http://localhost:3000 npm start   # a local CRM (development builds only)
npm run e2e                 # Playwright + Electron; on Linux run under xvfb-run
```

The end-to-end tests run the app with Chromium's sandbox on, as in production; on Linux they check that every
renderer has its own namespaces and a seccomp filter. Chromium can't sandbox root, so when the suite runs as root
(a container) it starts Electron as an unprivileged user instead (`TAXWISE_E2E_UID` / `TAXWISE_E2E_GID`, else the
user who ran sudo, else `nobody`; needs `setpriv`). If a Linux CI runner reports "No usable sandbox", let it create
unprivileged user namespaces (or install Electron's `chrome-sandbox` setuid root) rather than turning the sandbox off.

A development build may load `http://localhost` or `http://127.0.0.1`; a release build only loads the baked
`https://` URL. Development builds keep DevTools; release builds have none, and no "Inspect" menu.

**Locked down.** A bundle built with `--release` (`npm run build:release`, used by every `dist*` and `release`
script) runs locked down whatever its executable is called, and so does any packaged app
(`src/main/hardening.ts`). Locked down means: no DevTools or Inspect menu, `TAXWISE_APP_URL`,
`TAXWISE_USER_DATA_DIR` and `TAXWISE_E2E_WHATSAPP_FIXTURES` are ignored, and the app refuses to start with a
debugging or security-off switch (`--remote-debugging-port`, `--remote-debugging-pipe`, `--inspect*`,
`--js-flags`, `--disable-web-security`, `--ignore-certificate-errors`, `--host-resolver-rules`, `--no-sandbox`,
`--single-process`, …). Electron's
own `app.isPackaged` is decided from the executable's file name, so it is not trusted alone: a copy of the
installed app renamed to `electron.exe` would otherwise get DevTools on the WhatsApp panel. Playwright always
starts Electron with `--remote-debugging-port`, so `npm run e2e` uses a development build.

**Device key.** Kept only in the OS credential store (`safeStorage`: the Windows user profile's DPAPI, the macOS
Keychain). A release build that can't open the store shows an error and doesn't start; it never writes the key
in clear and never replaces an encrypted key while the store is locked. A development run without a store (Linux
with no keyring) falls back to a plain file.

## Build installers

| Variable | When | What breaks without it |
|---|---|---|
| `TAXWISE_APP_URL` | build | The CRM URL the app loads (`https://…`). The release build refuses to run without it. |
| `TAXWISE_UPDATE_URL` | build | Where electron-updater looks for `latest.yml` and installers. |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` (or an Azure Trusted Signing config) | Windows build | Signing. Unsigned installers trigger SmartScreen. |
| `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` (or `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`), `CSC_LINK`, `CSC_KEY_PASSWORD` | macOS build | Signing and notarisation. |

```bash
TAXWISE_APP_URL=https://app.twchartered.com TAXWISE_UPDATE_URL=https://downloads.twchartered.com/desktop \
  npm run dist:win     # Windows NSIS installer in release/
npm run dist:mac       # macOS dmg (universal), on a Mac
```

Certificates and Apple credentials live in CI secrets, never in this repository (§17).

**Fuses.** `scripts/fuses.ts` runs as electron-builder's `afterPack` hook, before signing, and sets:
`RunAsNode` off, `EnableNodeCliInspectArguments` off, `EnableEmbeddedAsarIntegrityValidation` on,
`OnlyLoadAppFromAsar` on, `EnableCookieEncryption` on (plus `NODE_OPTIONS` ignored and no extra `file://`
privileges). After the first signed build on each platform, start the installed app once: with asar
integrity on, an installer whose `app.asar` hash wasn't embedded refuses to start. If that happens on
Windows, upgrade electron-builder (it embeds the hash) rather than turning the fuse off.

### Sign (Windows)

1. Buy a code-signing certificate (OV, EV, or Azure Trusted Signing) **before rolling out to every PC**.
2. Put it in CI secrets (`WIN_CSC_LINK` as a base64 `.pfx` or a path, `WIN_CSC_KEY_PASSWORD`).
3. `npm run dist:win`. electron-builder signs the app, the installer and the uninstaller, and writes the
   certificate's publisher name into `app-update.yml`. The updater then refuses an update not signed by that
   publisher (`verifyUpdateCodeSignature`).

   electron-updater **skips** that check when `app-update.yml` names no publisher, which is what an unsigned build
   writes. So an unsigned build never auto-updates (`updateTrustProblem` in `src/main/updater.ts`; the log says
   "updater: off"), and `npm run release` passes `--config.forceCodeSigning=true`, so an unsigned build can't be
   published to the update feed. Unsigned trial installers from `npm run dist:win` must be replaced by hand.

### Notarise (macOS)

1. A Developer ID Application certificate and an App Store Connect API key.
2. `npm run dist:mac` on macOS with the variables above. The app uses the hardened runtime with
   `build/entitlements.mac.plist` (JIT for V8, microphone for voice notes, network client) and is notarised.

### Updates

electron-updater checks **at start and every 6 hours**, downloads in the background and installs on quit, on
signed Windows builds and on signed, notarised macOS builds (Squirrel.Mac checks the Developer ID). Elsewhere it
doesn't run, because nothing would check the update's signature.
Host the files electron-builder writes to `release/` (`latest.yml`, the installer, its blockmap) at
`TAXWISE_UPDATE_URL`. To use GitHub Releases instead (a public releases repository, or a token):

```bash
npx electron-builder --config.publish.provider=github --config.publish.owner=<owner> --config.publish.repo=<repo>
```

Settings → WhatsApp → **Download TaxWise Desktop** should point at the latest signed installer
(`NEXT_PUBLIC_DESKTOP_DOWNLOAD_URL` in the web app).

## Pilot: two PCs on the Staff office number

Try it on the Staff office number first (§7.25.9). Watch for any warning from WhatsApp, and stop if one appears.

1. **Settings → WhatsApp** (Partner): the five firm numbers are entered; Staff office is active,
   `usable_by` = partner, manager, employee; client mode **on**; Employee notifications **off**.
2. Install the signed build on **PC-A** and **PC-B** (for example FRONTDESK-1 and FRONTDESK-2).
3. On PC-A, sign in to the CRM as an Employee. The panel opens on the Staff office QR screen with
   *"Link this PC: on the Staff office phone, open WhatsApp → Settings → Linked devices → Link a device,
   and scan this code."* The custodian scans it with the Staff office phone.
4. When the chat list appears, the app reports the link. Check **Settings → Linked PCs** shows PC-A with
   Staff office, and that Partners were notified ("FRONTDESK-1 linked the Staff office number").
5. Repeat on PC-B. The WhatsApp groups page should now show "Staff office: 2 of 4".
6. Client mode checks (§18.3 Employee 8–10), on each PC:
   - **Open chat** on a client the Employee is on: the group opens beside the client's page, and the chip reads
     "XYZ Traders · client mode".
   - Reach any other chat (search is hidden; try a forwarded message or a notification): it closes with
     **Not one of your clients**, and the audit log shows `access_denied` once for that chat today.
   - A WhatsApp hand-off from a task (Data awaited → WhatsApp) opens the one-to-one chat in the panel and stays open.
     A hand-off allows only the first chat that opens after it, within a minute, on the same number; typing into
     WhatsApp before that chat appears cancels it. Try a hand-off to a number that isn't on WhatsApp, then press
     WhatsApp's next-chat keyboard shortcut: the chat it reaches must close with **Not one of your clients**.
   - Start the installed app with `--remote-debugging-port=9222`: it must refuse to start.
   - Download a PDF from the client's group: the prompt offers *Save to XYZ Traders documents* and
     *Save to another client…*, never *Save to this PC*; the CRM's upload dialog opens pre-filled.
   - Give the Employee a short cover on another client: its group opens; after the cover ends, an open chat closes
     within 5 minutes.
   - Break one entry in `selectors.ts` on a test build: the panel shows *"Client mode is unavailable because
     WhatsApp changed its page. A Partner has been told."* and Partners get the health notice.
7. Sign out of the CRM on PC-A: the panel disappears at once. Sign in as a Manager: Staff office shows
   (Managers may use it) and Managers' office is offered for linking. Sign in as a Partner: their own number
   is never offered as already linked on someone else's PC.
8. **Remove PC-B** in Settings → Linked PCs. Restart TaxWise Desktop on PC-B: it shows *"This PC was removed from
   TaxWise"* and its WhatsApp data is gone. Then remove PC-B from the Staff office phone's Linked devices list.
9. During the pilot, check on the live page that every entry in `src/whatsapp/selectors.ts` still matches (see
   below), that WhatsApp never shows "WhatsApp works with Google Chrome", and that voice notes record.
10. Check that **Open chat** finds groups by search (step 2 of §7.25.5), not only through the invite-link fallback:
    the search types with `execCommand('insertText')` and clicks the result with ordinary DOM mouse events. If
    WhatsApp starts ignoring those clicks, the fallback still opens groups that have an invite link; note it, and
    switch the click to trusted input (`webContents.sendInputEvent` from the main process).
11. Check `accept?code=` on a number already in the group opens the group rather than offering to join
    (§7.25.5 step 3 is marked [verify] in the spec).

### The 14-day rule

WhatsApp disconnects a phone's linked devices if the phone itself isn't opened for **14 days**. Each office phone
stays in the office with a named custodian who opens it at least weekly, during the weekly Linked devices check
(house rule 5, §7.25.10). If it happens, the panel shows the QR screen again for that number; the app reports the
number as unlinked, and the custodian links it again.

### The device limit

WhatsApp allows each number its phone plus **4 linked devices** (up to **10** with Meta Verified for Business
multi-agent). Every PC with a number linked in TaxWise Desktop uses one. Fifteen Employees can't each have the
Staff office number on their own PC: either set up a few shared WhatsApp desks, or subscribe to Meta Verified and
set `whatsapp_linked_device_limit` to 10. A Partner links **their own** number only on their own PC; the app never
shows a Partner's number to anyone else, even on the same PC.

## Fixing `selectors.ts`

WhatsApp changes its page often. Every DOM selector the app uses is in `src/whatsapp/selectors.ts`; nothing else
reads WhatsApp's page. When Partners get "client mode can't run on <PC>":

1. A Partner may turn client mode off in Settings so Employees can work meanwhile.
2. On a development build linked to a **test** number, open WhatsApp Web and inspect the parts named in the health
   notice (`searchBox`, `conversationTitle`, …).
3. Update `selectors.ts`, update `tests/fixtures/*.html` to the new structure, run `npm test`, release.

The self-check runs on load and every 10 minutes. Client mode fails **closed**: a cover hides the whole page
unless an allowed conversation is open, so a broken selector can only hide too much, never too little. If the
WhatsApp preload doesn't run on a page at all, a stylesheet the main process injects keeps that page blank; an
unexpected error while checking a chat shows the "unavailable" cover; and if the context can't be refreshed for
10 minutes, no chat is allowed (re-checked every 30 seconds).

## What the app never does

It never reads, copies or stores message content, never sends a message or presses Send, never scrapes contacts
or groups, and runs nothing in WhatsApp Web beyond the search-and-open step and the client-mode checks. It reads
only the open conversation's title and, while opening a chat, search-result titles.

## Desktop API contract (for the web CRM)

Route handlers under `app/api/desktop/*`, authenticated by the CRM session cookie (the app sends the
`persist:crm` cookies; it never uses a token from the page). Every response: `Cache-Control: no-store`,
`Content-Type: application/json`, body `{ ok: true, data }` or `{ ok: false, error, code?, ref? }` (lib/result.ts).

Request headers the app sends on every call:

| Header | Value |
|---|---|
| `X-TaxWise-Desktop` | app version, e.g. `0.1.0` (routes should require it) |
| `X-TaxWise-Device` | the device key: 64 lowercase hex characters |
| `Origin` | the CRM's own origin |
| `Content-Type` | `application/json` on POST |

Status rules: **401** without a session (never a redirect to /login); **403 with `code: "device_revoked"`** for a
revoked PC (the app then wipes every WhatsApp partition); any other refusal is 403/404/409 with a different
`code` (the app shows `error` and does not wipe).

`GET /api/desktop/context`

```json
{ "ok": true, "data": {
  "user": { "id": "<profiles.id>", "employeeId": "<employees.id or null>", "name": "Anita Rao", "role": "employee" },
  "clientMode": true,
  "employeeNotifications": false,
  "numbers": [
    { "id": "<firm_whatsapp_numbers.id>", "label": "Staff office", "kind": "staff_office",
      "usableBy": ["partner", "manager", "employee"], "ownerEmployeeId": null }
  ],
  "allowedGroups": [ { "clientId": "<uuid>", "clientName": "XYZ Traders", "groupName": "TW · TW-C-0142 · XYZ Traders" } ]
} }
```

`numbers`: active numbers this user may use (role in `usable_by`; a Partner's own number only to that Partner).
`allowedGroups`: Employees → groups (not closed) of clients they can see, covers in force included; Partners and
Managers → `null`. An Employee with `null` is rejected by the app.

`POST /api/desktop/whatsapp/open` `{ "clientId": "<uuid>" }` → `{ "groupName", "numberId", "inviteCode"?, "clientName"? }`
(same checks as Open chat: `can_open_whatsapp`; writes `audit_logs` `record_viewed` on `client_whatsapp_group`;
updates `last_opened_at`/`last_opened_by`). `inviteCode` is only the code (`chat.whatsapp.com/<code>`), for the main
process.

`POST /api/desktop/devices/checkin` `{ "deviceKey", "deviceName", "os", "appVersion" }` → `{ "deviceId" }`.

`POST /api/desktop/devices/link` `{ "deviceKey", "numberId", "linked": true|false }` → `{}`.

`POST /api/desktop/health` `{ "deviceKey", "failing": ["searchBox"] }` → `{}` (notify Partners at most once a day per PC).

`POST /api/desktop/access-denied` `{ "deviceKey", "numberId", "chatTitle" }` → `{}` (writes `audit_logs` `access_denied`;
the app sends it at most once per chat per day).

## `window.taxwiseDesktop` (the CRM page's side)

Present only inside TaxWise Desktop; exactly these members:

```ts
interface TaxwiseDesktop {
  version: string;
  openClientChat(clientId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  toggleWhatsApp(): Promise<{ visible: boolean }>;
  refreshContext(): Promise<void>;
  onDownload(callback: (file: {
    id: string; clientId: string | null; clientName: string | null;
    fileName: string; mimeType: string; size: number; bytes: Uint8Array; source: "whatsapp";
    complete(result: { uploaded: boolean }): void;
  }) => void): () => void; // returns unsubscribe
}
```

- Show desktop-only controls (top-bar WhatsApp toggle, "Open chat here") only when `window.taxwiseDesktop` exists.
- Open chat: `const r = await window.taxwiseDesktop.openClientChat(client.id); if (!r.ok) toast.error(r.error)`.
- Call `refreshContext()` after sign-in, after granting/ending a cover, and after changing WhatsApp settings.
- Register `onDownload` once in the staff layout. For each file: open the normal upload dialog pre-filled
  (client = `clientId`, or a client picker when `null`; title from `fileName`; category; FY/period), upload through the
  usual signed URL with `documents.source = 'whatsapp'`, then call `complete({ uploaded: true })`; on cancel
  `complete({ uploaded: false })`. Files over 25 MB never arrive.
- `wa.me` / `api.whatsapp.com/send` links keep working unchanged: the app opens them in its panel.
- In the app, links to other sites open in the system browser (https only; `mailto:` is refused), and
  `window.open` of a CRM page loads it in the CRM view. Prefer downloads (`Content-Disposition: attachment`) to pop-ups.
- A `blob:` (or `data:`) URL never replaces the CRM page, by navigation or `window.open`: its content is a file,
  not the CRM, and must not get `window.taxwiseDesktop`. Preview files in an `<iframe>` or `<object>` on the page
  (allowed for `https:`, `blob:` and `data:`), or download them.
