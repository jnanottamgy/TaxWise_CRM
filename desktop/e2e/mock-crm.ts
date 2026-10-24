/**
 * A stand-in for the web CRM, for end-to-end tests: two pages and the /api/desktop/* contract.
 * The test changes `state` directly to play each role.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Role = "partner" | "manager" | "employee";

export interface MockState {
  role: Role | null;
  /** The signed-in user's employee id (defaults by role; e-vinay is the Partner who owns n-vinay). */
  employeeId: string | null;
  /** Plays a server that wrongly sends every number, a Partner's own included, to anyone. */
  overshareNumbers: boolean;
  revoked: boolean;
  clientMode: boolean;
  employeeNotifications: boolean;
  allowedGroups: Array<{ clientId: string; clientName: string; groupName: string }>;
  requests: Array<{ method: string; path: string; body: unknown; headers: Record<string, string | string[] | undefined> }>;
}

export const XYZ = "TW · TW-C-0142 · XYZ Traders";
export const PATEL = "TW · TW-C-0201 · Patel Builders";

const NUMBERS = [
  { id: "n-vinay", label: "CA Vinay H Karlagere (Partner)", kind: "partner", usableBy: ["partner"], ownerEmployeeId: "e-vinay" },
  { id: "n-managers", label: "Managers' office", kind: "managers_office", usableBy: ["partner", "manager"], ownerEmployeeId: null },
  { id: "n-staff", label: "Staff office", kind: "staff_office", usableBy: ["partner", "manager", "employee"], ownerEmployeeId: null },
];

const DASHBOARD = `<!doctype html>
<html><head><meta charset="utf-8"><title>TaxWise</title></head>
<body>
  <h1>Firm today</h1>
  <a id="wa" href="https://wa.me/919845012345?text=Hi%20Ramesh%2C%20we%20still%20need%20the%20purchase%20register.%0A%E2%80%93%20Ravi">WhatsApp Ramesh</a>
  <a id="ext" href="https://example.com/">Income-tax portal</a>
  <a id="insecure" href="http://example.com/">Old link</a>
  <a id="blank" href="https://example.com/new" target="_blank">New tab</a>
  <a id="internal" href="/clients">Clients</a>
</body></html>`;

const LOGIN = `<!doctype html><html><head><meta charset="utf-8"><title>Sign in to TaxWise</title></head><body><h1>Sign in to TaxWise</h1></body></html>`;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

export async function startMockCrm(): Promise<{ url: string; state: MockState; close(): Promise<void> }> {
  const state: MockState = {
    role: "employee",
    employeeId: null,
    overshareNumbers: false,
    revoked: false,
    clientMode: true,
    employeeNotifications: false,
    allowedGroups: [{ clientId: "c-xyz", clientName: "XYZ Traders", groupName: XYZ }],
    requests: [],
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const body = req.method === "POST" ? await readBody(req) : null;
    state.requests.push({ method: req.method ?? "GET", path: url.pathname, body, headers: req.headers });

    if (url.pathname.startsWith("/api/desktop/")) {
      if (state.revoked) return send(res, 403, { ok: false, error: "This PC was removed from TaxWise.", code: "device_revoked" });
      if (!state.role) return send(res, 401, { ok: false, error: "Sign in to TaxWise.", code: "unauthenticated" });
      switch (url.pathname) {
        case "/api/desktop/context": {
          const role = state.role;
          const employeeId = state.employeeId ?? (role === "partner" ? "e-vinay" : role === "manager" ? "e-m1" : "e-emp2");
          return send(res, 200, {
            ok: true,
            data: {
              user: { id: `u-${employeeId}`, employeeId, name: role, role },
              clientMode: state.clientMode,
              employeeNotifications: state.employeeNotifications,
              numbers: state.overshareNumbers
                ? NUMBERS
                : NUMBERS.filter((n) => n.usableBy.includes(role) && (n.ownerEmployeeId === null || n.ownerEmployeeId === employeeId)),
              allowedGroups: role === "employee" ? state.allowedGroups : null,
            },
          });
        }
        case "/api/desktop/whatsapp/open": {
          const clientId = (body as { clientId?: string } | null)?.clientId;
          const g = state.allowedGroups.find((x) => x.clientId === clientId);
          if (!g) return send(res, 403, { ok: false, error: "You can't open this client's WhatsApp.", code: "forbidden" });
          return send(res, 200, { ok: true, data: { groupName: g.groupName, numberId: "n-staff", clientName: g.clientName } });
        }
        case "/api/desktop/devices/checkin":
          return send(res, 200, { ok: true, data: { deviceId: "d-1" } });
        case "/api/desktop/devices/link":
        case "/api/desktop/health":
        case "/api/desktop/access-denied":
          return send(res, 200, { ok: true, data: {} });
        default:
          return send(res, 404, { ok: false, error: "Not found", code: "not_found" });
      }
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(url.pathname === "/login" || !state.role ? LOGIN : DASHBOARD);
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        // The app's network service keeps idle connections open for reuse; don't wait for them.
        server.closeAllConnections();
      }),
  };
}
