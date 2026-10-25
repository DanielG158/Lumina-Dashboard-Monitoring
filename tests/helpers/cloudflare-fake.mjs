// A small fake of the Cloudflare API: tunnels, DNS records, Access logs, GraphQL analytics and the IP trace page.
import { createServer } from "node:http";

export async function startFakeCloudflare() {
  const state = {
    token: "good-token",
    zoneName: "example.test",
    tunnels: [
      { id: "t1", name: "homelab", status: "healthy", config_src: "local", connections: [1, 2, 3, 4].map((n) => ({ uuid: `c${n}`, colo_name: n % 2 ? "sin02" : "cgk01", is_pending_reconnect: false })) },
    ],
    records: [
      { id: "r1", type: "CNAME", name: "app.example.test", content: "t1.cfargotunnel.com", proxied: true, ttl: 1 },
      { id: "r2", type: "A", name: "home.example.test", content: "198.51.100.7", proxied: false, ttl: 120 },
      { id: "r3", type: "A", name: "blog.example.test", content: "203.0.113.9", proxied: true, ttl: 1 },
      { id: "r4", type: "TXT", name: "example.test", content: "v=spf1 -all", proxied: false, ttl: 1 },
    ],
    ip: "198.51.100.99",
    analyticsDenied: false,
    accessDenied: false,
    access: [
      { created_at: new Date().toISOString(), user_email: "me@example.test", app_domain: "app.example.test", allowed: true, ip_address: "198.51.100.5", action: "login" },
      ...Array.from({ length: 11 }, (_, i) => ({ created_at: new Date(Date.now() - i * 60_000).toISOString(), user_email: `x${i}@bad.test`, app_domain: "app.example.test", allowed: false, ip_address: "203.0.113.50", action: "login" })),
    ],
    calls: [],
  };
  const send = (res, status, body, type = "application/json") => { res.writeHead(status, { "content-type": type }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
  const ok = (res, result) => send(res, 200, { success: true, errors: [], result });
  const fail = (res, status, message) => send(res, status, { success: false, errors: [{ code: 10000, message }], result: null });

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      state.calls.push(`${req.method} ${url.pathname}`);
      if (url.pathname === "/cdn-cgi/trace") return send(res, 200, `fl=1\nip=${state.ip}\nts=1\n`, "text/plain");
      if (req.headers.authorization !== `Bearer ${state.token}`) return fail(res, 403, "Authentication error");
      const p = url.pathname.replace(/^\/client\/v4/, "");
      let m;
      if (p === "/graphql") {
        if (state.analyticsDenied) return send(res, 200, { data: null, errors: [{ message: "zone 'x' does not have access to the path" }] });
        const day = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
        return send(res, 200, { data: { viewer: { zones: [{ httpRequests1dGroups: [2, 1, 0].map((n, i) => ({ dimensions: { date: day(n) }, sum: { requests: 1000 * (i + 1), bytes: 5e6 * (i + 1), cachedRequests: 400 * (i + 1), cachedBytes: 2e6 * (i + 1), threats: i } })) }] } } });
      }
      if ((m = /^\/accounts\/[^/]+\/cfd_tunnel$/.exec(p))) return ok(res, state.tunnels);
      if ((m = /^\/accounts\/[^/]+\/cfd_tunnel\/([^/]+)\/configurations$/.exec(p))) return ok(res, { config: { ingress: [{ service: "http_status:404" }] } });
      if ((m = /^\/accounts\/[^/]+\/access\/logs\/access_requests$/.exec(p))) return state.accessDenied ? fail(res, 403, "Access: not enabled") : ok(res, state.access);
      if ((m = /^\/zones\/[^/]+$/.exec(p))) return ok(res, { name: state.zoneName });
      if ((m = /^\/zones\/[^/]+\/dns_records$/.exec(p))) {
        if (req.method === "GET") return ok(res, state.records);
        const rec = { id: "r" + (state.records.length + 1), ttl: 1, proxied: false, ...body };
        state.records.push(rec);
        return ok(res, rec);
      }
      if ((m = /^\/zones\/[^/]+\/dns_records\/([^/]+)$/.exec(p))) {
        const i = state.records.findIndex((r) => r.id === m[1]);
        if (i < 0) return fail(res, 404, "Record does not exist");
        if (req.method === "DELETE") { state.records.splice(i, 1); return ok(res, { id: m[1] }); }
        Object.assign(state.records[i], body);
        return ok(res, state.records[i]);
      }
      fail(res, 404, "not found " + p);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return { state, base: `http://127.0.0.1:${port}/client/v4`, close: () => server.close() };
}
