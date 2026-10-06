/* The operator, locally: the same handler the site deploys, behind a plain
   HTTP server so the laptop run uses the real signing path rather than a
   stand-in. */
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const handler = (await import(path.join(HERE, "../../site/api/price.mjs"))).default;

http.createServer(async (req, res) => {
  const shim = {
    setHeader: (k, v) => res.setHeader(k, v),
    status(code) { res.statusCode = code; return this; },
    json(obj) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(obj)); },
    end: () => res.end(),
  };
  try { await handler(req, shim); } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(e && e.message || e) }));
  }
}).listen(8910, () => console.log("price service on 8910"));
