# TaxWise Desktop ↔ web CRM contract

Written by the desktop build. The web routes under `app/api/desktop/*` and the CRM pages must implement exactly this.

DESKTOP API (app/api/desktop/*). Authenticated by the CRM's Supabase session cookie only; the app sends the persist:crm cookies through session.fetch and never a token from the page.

Every response:
- headers `Cache-Control: no-store` and `Content-Type: application/json`;
- body `{ ok: true, data }` or `{ ok: false, error: string, code?: string, ref?: string }` (lib/result.ts).

Headers the app sends on every request:
- `X-TaxWise-Desktop: <app version>` (routes should require it);
- `X-TaxWise-Device: <deviceKey>`, 64 lowercase hex characters;
- `Origin: <CRM origin>`;
- `Content-Type: application/json` on POST.

Status rules:
- 401 when there is no session. Never redirect /api/desktop/* to /login.
- 403 with `{ ok: false, error: "This PC was removed from TaxWise.", code: "device_revoked" }` when the device key in the header or body belongs to a desktop_devices row with revoked_at set. Apply this on EVERY route, context included. The app then wipes all WhatsApp data.
- Any other refusal uses 403/404/409 with a different code (forbidden, not_found, …). The app shows `error` and does not wipe.

1) GET /api/desktop/context → data:
```
{ user: { id: string /*profiles.id*/, employeeId: string | null /*employees.id*/, name: string, role: "partner"|"manager"|"employee"|"client" },
  clientMode: boolean /*firm_settings whatsapp_client_mode*/,
  employeeNotifications: boolean,
  numbers: Array<{ id: string, label: string, kind: "partner"|"managers_office"|"staff_office"|"other", usableBy: Array<"partner"|"manager"|"employee">, ownerEmployeeId: string | null /*firm_whatsapp_numbers.employee_id*/ }>,
  allowedGroups: Array<{ clientId: string, clientName: string, groupName: string }> | null }
```
- numbers = active firm numbers whose usable_by contains the user's role, except that a number with employee_id set is returned only to that Partner.
- allowedGroups: for Employees, the client_whatsapp_groups (not closed or deleted, primary and others) of clients they can see, covers in force included (can_open_whatsapp). For Partners and Managers it is null. An Employee must never get null; the app rejects that.
- Ids must match /^[A-Za-z0-9-]{1,64}$/ (uuids are fine).
- Also update desktop_devices.last_user_id and last_seen_at for the device in X-TaxWise-Device.
- A client (portal) user gets 403 code forbidden.

2) POST /api/desktop/whatsapp/open, body `{ clientId: string }` → data:
```
{ groupName: string, numberId: string, inviteCode?: string | null, clientName?: string }
```
- Same checks as Open chat (can_open_whatsapp); refuse with 403 forbidden, or 409 no_group with a plain sentence.
- Write audit_logs record_viewed on resource client_whatsapp_group, and update last_opened_at / last_opened_by.
- numberId is the firm number the user should open it on, and must be one of the context numbers for this user (Employee: Staff office; Manager: Managers' office; Partner: their own number if it is in the group, else Managers' office).
- inviteCode is ONLY the code part of chat.whatsapp.com/<code> (10–40 letters and digits), sent only to Partners/Managers or omitted. The app never passes it to the page.

3) POST /api/desktop/devices/checkin, body `{ deviceKey, deviceName, os, appVersion }` → data `{ deviceId: string }`. Upserts desktop_devices by device_key; refuses revoked devices with 403 device_revoked.

4) POST /api/desktop/devices/link, body `{ deviceKey, numberId, linked: boolean }` → data `{}`.
- linked=true inserts desktop_device_numbers (linked_by = current user) unless an active link exists, and notifies Partners (whatsapp_device_linked: "<device_name> linked the <label> number").
- linked=false sets unlinked_at on the active row.

5) POST /api/desktop/health, body `{ deviceKey, failing: string[] /*selector names such as "searchBox", "conversationTitle"*/ }` → data `{}`. Notify Partners (whatsapp_client_mode_down) at most once a day per PC.

6) NEW, needed by §7.25.5: POST /api/desktop/access-denied, body `{ deviceKey, numberId, chatTitle: string }` → data `{}`. Write audit_logs action access_denied (resource client_whatsapp_group or whatsapp_chat; details: chatTitle, numberId, device). The app already limits it to once per chat per IST day.

BRIDGE: window.taxwiseDesktop exists only inside TaxWise Desktop and has exactly these members:
```
{ version: string;
  openClientChat(clientId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  toggleWhatsApp(): Promise<{ visible: boolean }>;
  refreshContext(): Promise<void>;
  onDownload(cb: (file: { id: string; clientId: string | null; clientName: string | null; fileName: string; mimeType: string; size: number; bytes: Uint8Array; source: "whatsapp"; complete(r: { uploaded: boolean }): void }) => void): () => void /*unsubscribe*/ }
```
How CRM pages should use it:
(a) Detect it with components/shell/use-desktop.ts (already matches). Show the top-bar WhatsApp toggle and "Open chat here" only when it is present.
(b) Open chat: `const r = await window.taxwiseDesktop.openClientChat(clientId); if (!r.ok) toast.error(r.error)`. The app calls /whatsapp/open itself.
(c) Call refreshContext() after sign-in, after granting, extending or ending a cover, and after saving Settings → WhatsApp.
(d) Register onDownload ONCE in the staff layout. For each file, open the normal document upload dialog pre-filled: client = clientId (or a client picker when null), title from fileName, category to choose, FY/period. Upload with `new File([file.bytes], file.fileName, { type: file.mimeType })` through the usual signed-URL flow with documents.source = 'whatsapp'. Then call file.complete({ uploaded: true }), or complete({ uploaded: false }) on cancel. Files over 25 MB never arrive.
(e) Keep emitting wa.me hand-off links unchanged; the app opens them in its panel.
(f) Inside the app, external links open in the system browser and only https works (mailto: is refused, so prefer the Gmail compose URL). window.open of a CRM URL loads it in the CRM view, so prefer Content-Disposition: attachment downloads to pop-ups.
(g) Signed-out pages (/login, /set-password, /no-access, …) hide the panel immediately; signing out must remove the sb-*-auth-token cookies.
