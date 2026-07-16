import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const regionStore = path.join(dataDir, "regions.json");
const port = Number(process.env.PORT || 3000);

const clients = new Set();
let regions = [];
let publishing = null;
let localization = null;
let latestTopic = {
  name: "/localization/fix",
  payload: {
    lat: 39.904214,
    lon: 116.407413,
    altitude: 42.6,
    heading: 86,
    speed: 3.2,
    source: "simulated-backend"
  },
  receivedAt: new Date().toISOString()
};

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"]
]);

await mkdir(dataDir, { recursive: true });
try {
  if (existsSync(regionStore)) regions = JSON.parse(await readFile(regionStore, "utf8"));
} catch {
  regions = [];
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendSse(client, event, data) {
  client.write(`event: ${event}\n`);
  client.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const client of clients) sendSse(client, event, data);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function saveRegions() {
  await writeFile(regionStore, JSON.stringify(regions, null, 2));
}

async function runLangGraph(payload) {
  const endpoint = payload.graphEndpoint || process.env.LANGGRAPH_ENDPOINT;
  const requestPayload = {
    prompt: payload.prompt,
    mode: payload.mode,
    region: payload.region || null,
    context: payload.context || {}
  };

  if (!endpoint) {
    return {
      provider: "mock-langgraph",
      answer: "未配置 LangGraph endpoint，当前返回模拟结果。已接收任务、区域和上下文，后端接口保持可替换。",
      request: requestPayload,
      confidence: 0.82
    };
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestPayload)
  });
  const text = await response.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Keep raw text for LangGraph services that return plain text.
  }
  return { provider: "langgraph", status: response.status, ok: response.ok, answer: parsed };
}

function telemetryTick() {
  const base = latestTopic.payload || {};
  const jitter = () => (Math.random() - 0.5) * 0.00036;
  const telemetry = {
    time: new Date().toISOString(),
    lat: Number(base.lat ?? 39.904214) + jitter(),
    lon: Number(base.lon ?? 116.407413) + jitter(),
    altitude: Number(base.altitude ?? 42.6) + (Math.random() - 0.5) * 1.8,
    heading: (Number(base.heading ?? 86) + Math.random() * 4) % 360,
    speed: Math.max(0, Number(base.speed ?? 3.2) + (Math.random() - 0.5) * 0.35),
    source: base.source || "simulated-backend",
    topic: latestTopic.name,
    localization,
    publishing
  };

  broadcast("telemetry", telemetry);
  if (publishing?.active) {
    broadcast("publish", {
      time: telemetry.time,
      topic: publishing.topic,
      flag: publishing.flag,
      region: publishing.region,
      data: {
        flag: publishing.flag,
        region: publishing.region
      }
    });
  }
}

setInterval(telemetryTick, 1000);

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "").replace(/^\/+/, "");
  const filePath = path.join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const stream = createReadStream(filePath);
  stream.on("open", () => {
    res.writeHead(200, { "content-type": contentTypes.get(ext) || "application/octet-stream" });
  });
  stream.on("error", () => {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });
  stream.pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive"
      });
      res.write("\n");
      clients.add(res);
      sendSse(res, "hello", {
        time: new Date().toISOString(),
        regions,
        latestTopic,
        publishing,
        localization
      });
      req.on("close", () => clients.delete(res));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/regions") {
      json(res, 200, { regions });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/regions") {
      const region = await readJsonBody(req);
      const index = regions.findIndex((item) => item.id === region.id);
      if (index >= 0) regions[index] = region;
      else regions.push(region);
      await saveRegions();
      broadcast("regions", { regions });
      json(res, 200, { ok: true, regions });
      return;
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/regions/")) {
      const regionId = decodeURIComponent(url.pathname.slice("/api/regions/".length));
      const region = regions.find((item) => item.id === regionId);
      if (!region) {
        json(res, 404, { ok: false, error: "Region not found" });
        return;
      }
      regions = regions.filter((item) => item.id !== regionId);
      if (publishing?.region?.id === regionId) {
        publishing = null;
        broadcast("publish-state", publishing);
      }
      await saveRegions();
      broadcast("regions", { regions });
      json(res, 200, { ok: true, deleted: region, regions });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/publish/start") {
      const body = await readJsonBody(req);
      publishing = {
        active: true,
        flag: body.flag || "GPS_FLAG",
        topic: body.topic || "/selected_region",
        region: body.region,
        rateHz: Number(body.rateHz || 1),
        startedAt: new Date().toISOString()
      };
      broadcast("publish-state", publishing);
      json(res, 200, { ok: true, publishing });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/publish/stop") {
      publishing = null;
      broadcast("publish-state", publishing);
      json(res, 200, { ok: true, publishing });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/localization/start") {
      localization = {
        active: true,
        program: "localization",
        placeholder: true,
        startedAt: new Date().toISOString()
      };
      broadcast("localization-state", localization);
      json(res, 200, { ok: true, localization });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/localization/stop") {
      localization = null;
      broadcast("localization-state", localization);
      json(res, 200, { ok: true, localization });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agent/run") {
      const body = await readJsonBody(req);
      try {
        const result = await runLangGraph(body);
        broadcast("agent", { time: new Date().toISOString(), prompt: body.prompt, result });
        json(res, 200, { ok: true, result });
      } catch (error) {
        json(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/topic/")) {
      const topicName = decodeURIComponent(url.pathname.replace("/api/topic/", ""));
      const payload = await readJsonBody(req);
      latestTopic = {
        name: `/${topicName}`.replace(/^\/+/, "/"),
        payload,
        receivedAt: new Date().toISOString()
      };
      broadcast("topic", latestTopic);
      json(res, 200, { ok: true, latestTopic });
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      serveStatic(req, res);
      return;
    }

    json(res, 405, { ok: false, error: "Method not allowed" });
  } catch (error) {
    json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Satellite command WebUI running at http://127.0.0.1:${port}`);
});
