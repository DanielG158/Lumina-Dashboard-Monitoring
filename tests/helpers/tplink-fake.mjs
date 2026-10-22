// A fake TP-Link Archer router admin page. It implements the SERVER side of the protocol the real routers use, so the client can be
// tested end to end: RSA-encrypted password, and (older firmware) an AES-encrypted, RSA-signed conversation.
import http from "node:http";
import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync } from "node:crypto";

const b2h = (b64u) => Buffer.from(b64u, "base64url").toString("hex");
function makeKey(bits) {
  const jwk = generateKeyPairSync("rsa", { modulusLength: bits }).privateKey.export({ format: "jwk" });
  return { nn: b2h(jwk.n), ee: b2h(jwk.e), n: BigInt("0x" + b2h(jwk.n)), d: BigInt("0x" + b2h(jwk.d)), bytes: bits / 8 };
}
const modpow = (b, e, m) => { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; e >>= 1n; b = (b * b) % m; } return r; };
/** Raw RSA with the private key, then strip PKCS#1 v1.5 type 2 padding (Node refuses to do this itself). */
function rsaDecrypt(key, hex) {
  const m = modpow(BigInt("0x" + hex), key.d, key.n);
  const buf = Buffer.from(m.toString(16).padStart(key.bytes * 2, "0"), "hex");
  if (buf[0] !== 0 || buf[1] !== 2) throw new Error("bad RSA padding");
  return buf.subarray(buf.indexOf(0, 2) + 1).toString("utf8");
}

export async function startFakeRouter({ mode = "aes", password = "router-pass", username = "admin" } = {}) {
  const bits = mode === "plain" ? 2048 : 1024;
  const pwdKey = makeKey(bits), authKey = makeKey(1024);
  const state = { loginAttempts: 0, logins: 0, logouts: 0, requests: [], busy: false, sessionOpen: false,
    status: { cpu_usage: 0.12, mem_usage: 0.43, wan_ipv4_ipaddr: "203.0.113.9", wan_ipv4_gateway: "203.0.113.1", wan_ipv4_uptime: 86400, conn_type: "dhcp", lan_ipv4_ipaddr: "192.168.0.1",
      access_devices_wired: [{ macaddr: "AA-BB-CC-00-00-01", ipaddr: "192.168.0.10", hostname: "nas" }],
      access_devices_wireless_host: [{ macaddr: "AA-BB-CC-00-00-02", ipaddr: "192.168.0.11", hostname: "phone" }, { macaddr: "AA-BB-CC-00-00-03", ipaddr: "192.168.0.12", hostname: "laptop" }],
      access_devices_wireless_guest: [{ macaddr: "AA-BB-CC-00-00-04", ipaddr: "192.168.0.99", hostname: "guest" }] },
    firmware: { model: "Archer AX12", hardware_version: "Archer AX12 v1.0", firmware_version: "1.1.2 Build 20230101 rel.12345" } };
  const SEQ = 1234567, STOK = "stok-abc", COOKIE = "cookie-xyz";
  let ciph = null; // key and iv the client announced at login

  const aesEnc = (obj) => { const c = createCipheriv("aes-128-cbc", Buffer.from(ciph.key, "ascii"), Buffer.from(ciph.iv, "ascii")); return Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]).toString("base64"); };
  const aesDec = (b64) => { const d = createDecipheriv("aes-128-cbc", Buffer.from(ciph.key, "ascii"), Buffer.from(ciph.iv, "ascii")); return Buffer.concat([d.update(Buffer.from(b64, "base64")), d.final()]).toString("utf8"); };

  const srv = http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
      const json = (o, code = 200) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
      const url = new URL(req.url, "http://x");
      const p = url.pathname, form = url.searchParams.get("form");
      if (!p.startsWith("/cgi-bin/luci/;stok=")) { res.statusCode = 404; return res.end("not here"); }
      if (p === "/cgi-bin/luci/;stok=/login" && form === "keys") return json({ success: true, data: { password: [pwdKey.nn, pwdKey.ee] } });
      if (p === "/cgi-bin/luci/;stok=/login" && form === "auth" && mode === "aes") return json({ success: true, data: { seq: SEQ, key: [authKey.nn, authKey.ee] } });
      if (p === "/cgi-bin/luci/;stok=/login" && form === "login") {
        state.loginAttempts++;
        try {
          let pw, replyOk, replyBad;
          if (mode === "aes") {
            const body = new URLSearchParams(raw);
            const sign = body.get("sign"), data = body.get("data");
            let s = ""; for (let i = 0; i < sign.length; i += 256) s += rsaDecrypt(authKey, sign.slice(i, i + 256));
            const m = /^k=(\w{16})&i=(\w{16})&h=(\w{32})&s=(\d+)$/.exec(s);
            if (!m) throw new Error("bad signature text: " + s);
            ciph = { key: m[1], iv: m[2] };
            if (m[3] !== createHash("md5").update(username + password).digest("hex")) throw new Error("bad hash");
            if (Number(m[4]) !== SEQ + data.length) throw new Error("bad sequence");
            const text = aesDec(data);
            pw = rsaDecrypt(pwdKey, /password=([0-9a-f]+)/.exec(text)[1]);
            replyOk = () => json({ data: aesEnc({ success: true, data: { stok: STOK } }) });
            replyBad = (code) => json({ data: aesEnc({ success: false, data: { errorcode: code } }) });
          } else {
            pw = rsaDecrypt(pwdKey, /password=([0-9a-f]+)/.exec(raw)[1]);
            replyOk = () => json({ success: true, data: { stok: STOK } });
            replyBad = (code) => json({ success: false, data: { errorcode: code } });
          }
          if (state.busy) return replyBad("user conflict");
          if (pw !== password) return replyBad("login failed");
          state.logins++; state.sessionOpen = true;
          res.setHeader("set-cookie", `sysauth=${COOKIE}; path=/; HttpOnly`);
          return replyOk();
        } catch (e) { return json({ success: false, data: { errorcode: "bad request: " + e.message } }); }
      }
      if (p.startsWith(`/cgi-bin/luci/;stok=${STOK}/`) && (req.headers.cookie ?? "").includes(`sysauth=${COOKIE}`) && state.sessionOpen) {
        const path = p.slice(`/cgi-bin/luci/;stok=${STOK}/`.length) + "?form=" + form;
        let payload;
        if (mode === "aes") {
          const body = new URLSearchParams(raw);
          const sign = body.get("sign"), data = body.get("data");
          let s = ""; for (let i = 0; i < sign.length; i += 256) s += rsaDecrypt(authKey, sign.slice(i, i + 256));
          if (!/^h=\w{32}&s=\d+$/.test(s) || Number(/s=(\d+)/.exec(s)[1]) !== SEQ + data.length) return json({ data: aesEnc({ success: false, data: { errorcode: "bad signature" } }) });
          payload = JSON.parse(aesDec(data));
        } else payload = JSON.parse(raw);
        state.requests.push(path);
        const reply = (o) => (mode === "aes" ? json({ data: aesEnc(o) }) : json(o));
        if (path.startsWith("admin/status?form=all")) return reply({ success: true, data: state.status });
        if (path.startsWith("admin/firmware?form=upgrade")) return reply({ success: true, data: state.firmware });
        if (path.startsWith("admin/system?form=logout")) { state.logouts++; state.sessionOpen = false; return reply({ success: true, data: {} }); }
        return reply({ success: false, data: { errorcode: "not found" } });
      }
      return json({ success: false, data: { errorcode: "timeout" } });
    });
  }).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  return { url: `http://127.0.0.1:${srv.address().port}`, state, password, close: () => srv.close() };
}
