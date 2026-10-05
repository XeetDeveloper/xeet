/* The two things on the site that change without a deploy: the contract
 * address in the hero, and the X account the logos link to.
 *
 * The page is static, so the address cannot live in the HTML — editing it
 * would mean a redeploy. It lives in Edge Config instead: read here on every
 * request, written by the admin panel, visible to the page a second later.
 *
 * Two tokens are involved and they are not interchangeable. The read token is
 * scoped to the store and only reads; the write token is the account token and
 * only ever leaves this file inside a PATCH to one fixed key. Neither is sent
 * to the browser, and the browser never gets a session either — the panel
 * holds the password and presents it with each write, so a stolen response
 * gives an attacker nothing to replay.
 */
const crypto = require("node:crypto");

const KEYS = { ca: "xeet_ca", x: "xeet_x" };
const {
  XEET_EDGE_ID, XEET_EDGE_TOKEN, XEET_WRITE_TOKEN, XEET_TEAM_ID,
  XEET_ADMIN_USER, XEET_ADMIN_SALT, XEET_ADMIN_HASH,
} = process.env;

/* An empty value is not an error: it means "not announced yet", which is what
   the page renders as "soon". */
async function read(key) {
  const url = `https://edge-config.vercel.com/${XEET_EDGE_ID}/item/${KEYS[key]}?token=${XEET_EDGE_TOKEN}`;
  const r = await fetch(url, { cache: "no-store" });
  if (r.status === 404) return "";
  if (!r.ok) throw new Error("edge config read failed: " + r.status);
  const v = await r.json();
  return typeof v === "string" ? v : "";
}

async function write(items) {
  const r = await fetch(
    `https://api.vercel.com/v1/edge-config/${XEET_EDGE_ID}/items?teamId=${XEET_TEAM_ID}`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${XEET_WRITE_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        items: Object.entries(items).map(([k, value]) => ({ operation: "upsert", key: KEYS[k], value })),
      }),
    },
  );
  if (!r.ok) throw new Error("edge config write failed: " + r.status);
}

/* Constant-time, and on the hash rather than the password: the deployment
   holds a salted scrypt digest and never the password itself. */
function authorized(user, pass) {
  if (typeof user !== "string" || typeof pass !== "string") return false;
  const nameOk = crypto.timingSafeEqual(
    crypto.createHash("sha256").update(user).digest(),
    crypto.createHash("sha256").update(XEET_ADMIN_USER || "").digest(),
  );
  const got = crypto.scryptSync(pass, Buffer.from(XEET_ADMIN_SALT, "hex"), 32);
  const want = Buffer.from(XEET_ADMIN_HASH, "hex");
  const passOk = got.length === want.length && crypto.timingSafeEqual(got, want);
  return nameOk && passOk;
}

/* Guessing is the only attack this endpoint has, so make it slow. The counter
   is per instance, which is not a real quota — it is enough to make a script
   pointless while leaving a forgotten password recoverable by waiting. */
const tries = new Map();
const WINDOW = 10 * 60 * 1000;
function throttled(ip) {
  const now = Date.now();
  const hits = (tries.get(ip) || []).filter((t) => now - t < WINDOW);
  tries.set(ip, hits);
  if (tries.size > 500) tries.clear();
  return hits.length >= 8;
}
function note(ip) {
  tries.set(ip, [...(tries.get(ip) || []), Date.now()]);
}

/* What counts as an address: an EVM contract, a Solana mint, or nothing at
   all. Anything else is a typo, and a typo here is money sent to no one. */
function cleanCa(ca) {
  const s = String(ca == null ? "" : ca).trim();
  if (!s || s.toLowerCase() === "soon") return "";
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return s;
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return s;
  return null;
}

/* A handle, however it was pasted — with the @, or as a whole profile URL.
   Stored bare, so the page owns the shape of the link it builds. */
function cleanHandle(x) {
  let s = String(x == null ? "" : x).trim();
  if (!s) return "";
  s = s.replace(/^https?:\/\/(www\.)?(twitter|x)\.com\//i, "").replace(/[/?#].*$/, "");
  s = s.replace(/^@/, "");
  return /^[A-Za-z0-9_]{1,15}$/.test(s) ? s : null;
}

module.exports = async (req, res) => {
  try {
    if (req.method === "GET") {
      const [ca, x] = await Promise.all([read("ca"), read("x")]);
      res.setHeader("cache-control", "public, max-age=0, s-maxage=10");
      return res.status(200).json({ ca, x });
    }

    if (req.method === "POST") {
      const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
      if (throttled(ip)) return res.status(429).json({ error: "Too many attempts. Wait 10 minutes." });

      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      if (!authorized(body.user, body.pass)) {
        note(ip);
        await new Promise((r) => setTimeout(r, 400));
        return res.status(401).json({ error: "Wrong login or password." });
      }

      /* Only the fields the panel actually sent are touched, so saving one
         never silently clears the other. */
      const items = {};
      if ("ca" in body) {
        const ca = cleanCa(body.ca);
        if (ca === null) return res.status(400).json({ error: "Not an address. Expected 0x… or a Solana mint." });
        items.ca = ca;
      }
      if ("x" in body) {
        const x = cleanHandle(body.x);
        if (x === null) return res.status(400).json({ error: "Not an X handle. Expected @name." });
        items.x = x;
      }
      if (!Object.keys(items).length) return res.status(400).json({ error: "Nothing to save." });

      await write(items);
      return res.status(200).json(items);
    }

    res.setHeader("allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: "Server error" });
  }
};
