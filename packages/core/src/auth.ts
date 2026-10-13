import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Store, UserRow } from "./db.js";
import { hashPassword, randomToken, sha256, verifyPassword } from "./crypto.js";

export type Role = UserRow["role"];
export interface AuthUser {
  id: number;
  username: string;
  role: Role;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
    sessionHash?: string;
  }
}

export const SESSION_COOKIE = "lumina_session";
const ABSOLUTE_MAX_S = 7 * 86400;
const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };
export const PUBLIC_PATHS = new Set(["/api/auth/status", "/api/auth/login", "/api/auth/setup", "/api/auth/restore", "/api/auth/skip-setup"]);

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function clientIp(req: FastifyRequest): string {
  if (process.env.LUMINA_TRUST_PROXY === "1") {
    const fwd = (req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"]) as string | undefined;
    if (fwd) return fwd.split(",")[0].trim();
  }
  return req.ip;
}

/** Anonymous visitors are read-only viewers; only operator and admin accounts exist. */
export const requireRole = (min: "operator" | "admin") => async (req: FastifyRequest, reply: FastifyReply) => {
  if (!req.user) return reply.code(401).send({ error: "Sign in to do this" });
  if (RANK[req.user.role] < RANK[min]) return reply.code(403).send({ error: `This needs the ${min} role` });
};

class Throttle {
  private hits = new Map<string, { count: number; first: number; lockedUntil: number }>();
  constructor(private max: number, private windowMs: number, private lockMs: number) {}
  locked(key: string): number {
    const h = this.hits.get(key);
    return h && h.lockedUntil > Date.now() ? Math.ceil((h.lockedUntil - Date.now()) / 1000) : 0;
  }
  fail(key: string) {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || now - h.first > this.windowMs) return void this.hits.set(key, { count: 1, first: now, lockedUntil: 0 });
    h.count += 1;
    if (h.count >= this.max) h.lockedUntil = now + this.lockMs;
  }
  reset(key: string) {
    this.hits.delete(key);
  }
}

export function createAuth(store: Store, idleMinutes: () => number) {
  const idleSeconds = () => Math.max(5, idleMinutes()) * 60;
  const nowS = () => Math.floor(Date.now() / 1000);

  return {
    createSession(userId: number, ip: string, ua: string | null) {
      const token = randomToken();
      const expires = nowS() + idleSeconds();
      store.sessions.create(sha256(token), userId, expires, ip, ua);
      return { token, maxAge: idleSeconds() };
    },

    authenticate(cookieHeader: string | undefined): { user: AuthUser; hash: string } | null {
      const token = parseCookies(cookieHeader)[SESSION_COOKIE];
      if (!token) return null;
      const hash = sha256(token);
      const s = store.sessions.get(hash);
      const now = nowS();
      if (!s || s.expiresAt < now || s.createdAt + ABSOLUTE_MAX_S < now) {
        if (s) store.sessions.delete(hash);
        return null;
      }
      if (now - s.lastSeen > 60) store.sessions.touch(hash, Math.min(now + idleSeconds(), s.createdAt + ABSOLUTE_MAX_S));
      return { user: { id: s.userId, username: s.username, role: s.role }, hash };
    },

    destroy: (hash: string) => store.sessions.delete(hash),
    idleSeconds,
  };
}

export type Auth = ReturnType<typeof createAuth>;

const Username = z.string().trim().min(3).max(32).regex(/^[A-Za-z0-9._-]+$/, "Use letters, numbers, dot, dash or underscore");
const Password = z.string().min(8, "Use at least 8 characters").max(200);
const RoleSchema = z.enum(["admin", "operator"]);

export function registerAuthRoutes(
  app: FastifyInstance,
  store: Store,
  auth: Auth,
  audit: (req: FastifyRequest, action: string, target?: string | null, detail?: string | null, user?: string | null) => void,
  publicView: () => boolean,
  openAccess: () => boolean,
  setupCode: { check: (code: unknown) => boolean; clear: () => void; required: () => boolean },
) {
  const ipThrottle = new Throttle(10, 15 * 60_000, 10 * 60_000);
  const userThrottle = new Throttle(5, 15 * 60_000, 10 * 60_000);

  const secureFlag = (req: FastifyRequest) => (req.protocol === "https" || req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "");
  const setCookie = (req: FastifyRequest, reply: FastifyReply, token: string, maxAge: number) =>
    reply.header("set-cookie", `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secureFlag(req)}`);
  const publicUser = (u: { id: number; username: string; role: Role }) => ({ id: u.id, username: u.username, role: u.role });

  async function startSession(req: FastifyRequest, reply: FastifyReply, user: UserRow) {
    const { token, maxAge } = auth.createSession(user.id, clientIp(req), (req.headers["user-agent"] as string | undefined) ?? null);
    setCookie(req, reply, token, maxAge);
    store.users.touchLogin(user.id);
    return publicUser(user);
  }

  app.get("/api/auth/status", async (req) => {
    const session = auth.authenticate(req.headers.cookie);
    return { setupRequired: store.users.count() === 0, setupCodeRequired: setupCode.required(), openAccess: openAccess(), publicView: publicView(), user: session ? publicUser(session.user) : null };
  });

  app.post("/api/auth/setup", async (req, reply) => {
    if (store.users.count() > 0) return reply.code(409).send({ error: "Setup is already complete" });
    const body = z.object({ username: Username, password: Password, setupCode: z.string().optional() }).parse(req.body);
    if (!setupCode.check(body.setupCode)) return reply.code(403).send({ error: "Wrong setup code" });
    const id = store.users.create(body.username, await hashPassword(body.password), "admin");
    const user = store.users.byId(id)!;
    setupCode.clear();
    audit(req, "setup", body.username, "first admin created", body.username);
    return startSession(req, reply, user);
  });

  app.post("/api/auth/login", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = z.object({ username: z.string().max(64), password: z.string().max(200) }).parse(req.body);
    const ip = clientIp(req);
    const wait = Math.max(ipThrottle.locked(ip), userThrottle.locked(body.username.toLowerCase()));
    if (wait > 0) {
      audit(req, "login-blocked", body.username, `locked for ${wait}s`, body.username);
      return reply.code(429).send({ error: `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).` });
    }
    const user = store.users.byName(body.username);
    const ok = await verifyPassword(body.password, user?.passwordHash ?? null);
    if (!user || !ok) {
      ipThrottle.fail(ip);
      userThrottle.fail(body.username.toLowerCase());
      audit(req, "login-failed", body.username, null, body.username);
      return reply.code(401).send({ error: "Wrong username or password" });
    }
    ipThrottle.reset(ip);
    userThrottle.reset(body.username.toLowerCase());
    audit(req, "login", user.username, null, user.username);
    return startSession(req, reply, user);
  });

  app.post("/api/auth/logout", async (req, reply) => {
    if (req.sessionHash) auth.destroy(req.sessionHash);
    audit(req, "logout", req.user?.username ?? null);
    reply.header("set-cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    return { ok: true };
  });

  app.post("/api/auth/password", async (req, reply) => {
    const body = z.object({ current: z.string().max(200), next: Password }).parse(req.body);
    const user = store.users.byId(req.user!.id);
    if (!user) return reply.code(400).send({ error: "Open access has no account — create an admin account first" });
    if (!(await verifyPassword(body.current, user.passwordHash))) return reply.code(400).send({ error: "Current password is wrong" });
    store.users.setPassword(user.id, await hashPassword(body.next));
    store.sessions.deleteForUser(user.id);
    const fresh = auth.createSession(user.id, clientIp(req), (req.headers["user-agent"] as string | undefined) ?? null);
    setCookie(req, reply, fresh.token, fresh.maxAge);
    audit(req, "password-changed", user.username);
    return { ok: true };
  });

  const admin = requireRole("admin");

  app.get("/api/users", { preHandler: admin }, async () =>
    store.users.list().map((u) => ({ id: u.id, username: u.username, role: u.role, createdAt: u.createdAt, lastLogin: u.lastLogin })),
  );

  app.post("/api/users", { preHandler: admin }, async (req, reply) => {
    const body = z.object({ username: Username, password: Password, role: RoleSchema }).parse(req.body);
    if (store.users.byName(body.username)) return reply.code(409).send({ error: "That username is taken" });
    store.users.create(body.username, await hashPassword(body.password), body.role);
    setupCode.clear();
    audit(req, "user-created", body.username, `role ${body.role}`);
    return reply.code(201).send({ ok: true });
  });

  app.put("/api/users/:id", { preHandler: admin }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = z.object({ role: RoleSchema.optional(), password: Password.optional() }).parse(req.body);
    const user = store.users.byId(id);
    if (!user) return reply.code(404).send({ error: "User not found" });
    if (body.role && body.role !== user.role) {
      if (user.role === "admin" && store.users.countAdmins() <= 1) return reply.code(400).send({ error: "There must be at least one admin" });
      store.users.setRole(id, body.role);
      audit(req, "user-role-changed", user.username, `${user.role} -> ${body.role}`);
    }
    if (body.password) {
      store.users.setPassword(id, await hashPassword(body.password));
      store.sessions.deleteForUser(id);
      audit(req, "user-password-reset", user.username);
    }
    return { ok: true };
  });

  app.delete("/api/users/:id", { preHandler: admin }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const user = store.users.byId(id);
    if (!user) return reply.code(404).send({ error: "User not found" });
    if (id === req.user!.id) return reply.code(400).send({ error: "You can't delete your own account" });
    if (user.role === "admin" && store.users.countAdmins() <= 1) return reply.code(400).send({ error: "There must be at least one admin" });
    store.users.delete(id);
    audit(req, "user-deleted", user.username);
    return { ok: true };
  });
}
