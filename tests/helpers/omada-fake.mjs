// A fake TP-Link Omada controller that behaves like the real one's web API: login with a cookie and a CSRF token,
// an HTML page when the session is not valid, sites and devices.
import http from "node:http";

export async function startFakeOmada() {
  let session = "sess-1", logins = 0, expireNext = false;
  const dev = (o) => ({ mac: "AA-BB-CC-00-00-01", name: "Device", type: "ap", model: "EAP610", showModel: "EAP610 v2", status: 14, statusCategory: 1, ip: "192.168.0.20", uptimeLong: 90000, cpuUtil: 12, memUtil: 41, firmwareVersion: "1.2.3", needUpgrade: false, clientNum: 0, ...o });
  const sites = {
    s1: [dev({ mac: "AA-00-00-00-00-01", name: "ER605", type: "gateway", model: "ER605", showModel: "ER605 v2", ip: "192.168.0.1", cpuUtil: 8, memUtil: 55 }),
      dev({ mac: "AA-00-00-00-00-02", name: "SG2008P", type: "switch", model: "TL-SG2008P", ip: "192.168.0.2", cpuUtil: 3, memUtil: 30 }),
      dev({ mac: "AA-00-00-00-00-03", name: "Living room AP", type: "ap", ip: "192.168.0.21", clientNum: 12, needUpgrade: true, cpuUtil: 95 }),
      dev({ mac: "AA-00-00-00-00-04", name: "Garage AP", type: "ap", ip: "192.168.0.22", status: 0, statusCategory: 0, clientNum: 0 }),
      dev({ mac: "AA-00-00-00-00-05", name: "New AP", type: "ap", ip: "192.168.0.23", status: 20, statusCategory: 2 })],
    s2: [dev({ mac: "BB-00-00-00-00-01", name: "Office AP", type: "ap", ip: "192.168.1.21", clientNum: 5 })],
  };
  const srv = http.createServer((req, res) => {
    const send = (o) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      if (req.url === "/api/info") return send({ errorCode: 0, result: { controllerVer: "5.14.26.1", omadacId: "abc123", apiVer: "3" } });
      if (req.url === "/abc123/api/v2/login" && req.method === "POST") {
        const b = JSON.parse(body || "{}");
        if (b.username !== "viewer" || b.password !== "secret") return send({ errorCode: -30109, msg: "Log in failed. The username or password is incorrect." });
        logins++; session = `sess-${logins}`;
        res.setHeader("set-cookie", [`TPEAP_SESSIONID=${session}; Path=/; HttpOnly`]);
        return send({ errorCode: 0, result: { token: `tok-${logins}` } });
      }
      const authed = (req.headers.cookie ?? "").includes(`TPEAP_SESSIONID=${session}`) && req.headers["csrf-token"] === `tok-${logins}` && !expireNext;
      if (!authed) { res.setHeader("content-type", "text/html"); return res.end("<html>Please log in</html>"); }
      if (req.url === "/abc123/api/v2/users/current") return send({ errorCode: 0, result: { name: "viewer", privilege: { sites: [{ key: "s1", name: "Home" }, { key: "s2", name: "Office" }] } } });
      const m = /^\/abc123\/api\/v2\/sites\/(\w+)\/devices$/.exec(req.url);
      if (m && sites[m[1]]) return send({ errorCode: 0, result: sites[m[1]] });
      res.statusCode = 404; res.end("{}");
    });
  }).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const url = `http://127.0.0.1:${srv.address().port}`;

  const state = {
    get logins() { return logins; },
    forgetSession() { session = "the-server-forgot-us"; },
    sites,
  };
  return { url, state, close: () => srv.close() };
}
