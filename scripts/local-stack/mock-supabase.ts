/**
 * A local stand-in for a Supabase project's HTTP API, for the QA stack only (README.md).
 *
 *   /auth/v1/user                  the signed-in user, from an HS256 token signed with the stack's secret
 *   /auth/v1/token                 refresh_token (the same user, a fresh token) and password grants
 *   /auth/v1/logout                204
 *   /auth/v1/factors/:id/…         challenge / verify (accepts the documented QA code only)
 *   /auth/v1/admin/users[/:id]     reads for the service role; changes answer 501
 *   /storage/v1/*                  JSON 404 (objects) / 501 (buckets, uploads): the stack has no file storage,
 *                                  so file features show their designed error states
 *   /rest/v1/*                     forwarded to PostgREST
 *
 * Started by `stack.ts up`; reads .local-stack/secrets.json and users.json. Never deploy this.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PORTS, QA_TOTP_CODE, STATE_FILES, readSecrets } from "./config";
import { authUserObject, sessionFor, TOTP_FACTOR_ID, verifyJwt, type AuthUser, type Claims } from "./jwt";

const secrets = readSecrets();
if (!secrets) {
  console.error("No .local-stack/secrets.json: run `npx tsx scripts/local-stack/stack.ts up`.");
  process.exit(1);
}
const SECRET = secrets.jwtSecret;
const QA_PASSWORD = secrets.qaPassword;

function users(): AuthUser[] {
  try {
    return JSON.parse(readFileSync(STATE_FILES.users, "utf8")) as AuthUser[];
  } catch {
    return [];
  }
}
const byId = (id: string | undefined) => users().find((u) => u.id === id) ?? null;
const byKey = (key: string | undefined) => users().find((u) => u.key === key) ?? null;
const byEmail = (email: string | undefined) => users().find((u) => u.email.toLowerCase() === (email ?? "").toLowerCase()) ?? null;

function cors(req: http.IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  return {
    "access-control-allow-origin": origin ?? "*",
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS",
    "access-control-allow-headers": String(req.headers["access-control-request-headers"] ?? "authorization,apikey,content-type,prefer,range,x-client-info,accept-profile,content-profile,x-upsert"),
    "access-control-expose-headers": "content-range,content-location,x-total-count",
    vary: "origin",
  };
}

function send(req: http.IncomingMessage, res: http.ServerResponse, status: number, body?: unknown) {
  const headers: Record<string, string> = { ...cors(req) };
  if (body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  headers["content-type"] = "application/json";
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

/** GoTrue's error shape. */
const authError = (code: number, error_code: string, msg: string) => ({ code, error_code, msg });
const NOT_HERE = "Not available in the local QA stack (scripts/local-stack). Use a real Supabase project for this.";

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function bearer(req: http.IncomingMessage): Claims | null {
  return verifyJwt(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""), SECRET);
}

function log(line: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...line })}\n`);
}

async function auth(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const path = url.pathname.slice("/auth/v1".length) || "/";
  const method = req.method ?? "GET";

  if (path === "/health") return send(req, res, 200, { version: "local-qa", name: "GoTrue", description: "TaxWise local QA stand-in" });
  if (path === "/settings") {
    return send(req, res, 200, { external: { email: true }, disable_signup: true, mailer_autoconfirm: true, phone_autoconfirm: false, sms_provider: "" });
  }
  if (path === "/.well-known/jwks.json") return send(req, res, 200, { keys: [] });

  if (path === "/user") {
    const claims = bearer(req);
    const u = claims ? byId(claims.sub) : null;
    if (!claims || !u) return send(req, res, 403, authError(403, "bad_jwt", "invalid JWT: unable to parse or verify signature, token is expired"));
    if (method === "GET") return send(req, res, 200, authUserObject(u));
    if (method === "PUT") return send(req, res, 200, authUserObject(u)); // password change: nothing is stored
    return send(req, res, 405, authError(405, "method_not_allowed", "Method not allowed"));
  }

  if (path === "/token" && method === "POST") {
    const grant = url.searchParams.get("grant_type");
    const body = await readBody(req);
    if (grant === "refresh_token") {
      const [, key, aal] = String(body.refresh_token ?? "").split(".");
      const u = byKey(key);
      if (!u) return send(req, res, 400, authError(400, "refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found"));
      return send(req, res, 200, sessionFor(u, SECRET, { aal: aal === "aal2" ? "aal2" : "aal1" }));
    }
    if (grant === "password") {
      const u = byEmail(String(body.email ?? ""));
      if (!u || body.password !== QA_PASSWORD) return send(req, res, 400, authError(400, "invalid_credentials", "Invalid login credentials"));
      return send(req, res, 200, sessionFor(u, SECRET, { aal: "aal1" }));
    }
    return send(req, res, 400, authError(400, "unsupported_grant_type", NOT_HERE));
  }

  if (path === "/logout") return send(req, res, 204);

  const factor = path.match(/^\/factors(?:\/([^/]+))?(?:\/(challenge|verify))?$/);
  if (factor) {
    const claims = bearer(req);
    const u = claims ? byId(claims.sub) : null;
    if (!u) return send(req, res, 401, authError(401, "no_authorization", "This endpoint requires a valid Bearer token"));
    const [, id, step] = factor;
    if (id && id === TOTP_FACTOR_ID(u.id) && step === "challenge" && method === "POST") {
      return send(req, res, 200, { id: randomUUID(), type: "totp", expires_at: Math.floor(Date.now() / 1000) + 300 });
    }
    if (id && id === TOTP_FACTOR_ID(u.id) && step === "verify" && method === "POST") {
      const body = await readBody(req);
      if (body.code !== QA_TOTP_CODE) return send(req, res, 422, authError(422, "mfa_verification_failed", "Invalid TOTP code entered"));
      return send(req, res, 200, sessionFor(u, SECRET, { aal: "aal2" }));
    }
    return send(req, res, 501, authError(501, "not_implemented", NOT_HERE));
  }

  if (path.startsWith("/admin/")) {
    const claims = bearer(req);
    if (claims?.role !== "service_role") return send(req, res, 403, authError(403, "not_admin", "User not allowed"));
    const m = path.match(/^\/admin\/users(?:\/([^/]+))?(\/factors)?$/);
    if (m && method === "GET") {
      const [, id, factors] = m;
      if (!id) {
        const all = users().map((u) => authUserObject(u));
        return send(req, res, 200, { users: all, aud: "authenticated", total: all.length });
      }
      const u = byId(id);
      if (!u) return send(req, res, 404, authError(404, "user_not_found", "User not found"));
      if (factors) return send(req, res, 200, authUserObject(u).factors ?? []);
      return send(req, res, 200, authUserObject(u));
    }
    return send(req, res, 501, authError(501, "not_implemented", NOT_HERE));
  }

  return send(req, res, 404, authError(404, "not_found", NOT_HERE));
}

function storage(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const path = url.pathname.slice("/storage/v1".length);
  if (path.startsWith("/object/") && !path.startsWith("/object/upload/sign/")) {
    return send(req, res, 404, { statusCode: "404", error: "not_found", message: "Object not found. The local QA stack has no file storage." });
  }
  return send(req, res, 501, { statusCode: "501", error: "not_implemented", message: "Storage isn't available in the local QA stack." });
}

function rest(req: http.IncomingMessage, res: http.ServerResponse, url: URL, started: number) {
  const target = `http://127.0.0.1:${PORTS.postgrest}${url.pathname.slice("/rest/v1".length) || "/"}${url.search}`;
  const headers = { ...req.headers };
  delete headers.host;
  const upstream = http.request(target, { method: req.method, headers }, (r) => {
    const status = r.statusCode ?? 502;
    const out = { ...r.headers, ...cors(req) };
    if (status < 400) {
      res.writeHead(status, out);
      r.pipe(res);
      return;
    }
    // Errors are buffered so the log says what PostgREST answered.
    const chunks: Buffer[] = [];
    r.on("data", (c: Buffer) => chunks.push(c));
    r.on("end", () => {
      const body = Buffer.concat(chunks);
      res.writeHead(status, out);
      res.end(body);
      const role = bearer(req)?.role ?? "?";
      log({ kind: "rest", status, method: req.method, path: `${url.pathname}${url.search}`.slice(0, 600), role, ms: Date.now() - started, body: body.toString("utf8").slice(0, 600) });
    });
  });
  upstream.on("error", (e) => {
    log({ kind: "rest", status: 502, method: req.method, path: url.pathname, error: String(e) });
    send(req, res, 502, { code: "PGRST000", message: `PostgREST is unreachable: ${String(e)}` });
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  const url = new URL(req.url ?? "/", "http://local");
  if (req.method === "OPTIONS") return send(req, res, 204);
  if (url.pathname.startsWith("/rest/v1")) return rest(req, res, url, started);
  res.on("finish", () => {
    if (res.statusCode >= 400 || !url.pathname.startsWith("/auth/v1/user")) {
      log({ kind: url.pathname.split("/")[1] ?? "other", status: res.statusCode, method: req.method, path: url.pathname, ms: Date.now() - started });
    }
  });
  if (url.pathname.startsWith("/auth/v1")) {
    auth(req, res, url).catch((err) => send(req, res, 500, authError(500, "unexpected_failure", String(err))));
    return;
  }
  if (url.pathname.startsWith("/storage/v1")) return storage(req, res, url);
  if (url.pathname === "/health") return send(req, res, 200, { ok: true });
  return send(req, res, 404, { error: "not_found", message: NOT_HERE, path: url.pathname });
});

server.keepAliveTimeout = 65_000;
server.listen(PORTS.mock, "127.0.0.1", () => log({ kind: "start", msg: `Supabase stand-in on http://127.0.0.1:${PORTS.mock} → PostgREST :${PORTS.postgrest}` }));
