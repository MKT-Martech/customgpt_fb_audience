// server.js
import express from "express";
import cors from "cors";
import "dotenv/config";
import fetchPkg from "node-fetch";
const fetch = globalThis.fetch || fetchPkg;

const app = express();

app.use(
  cors({
    origin: ["http://localhost:3000", "https://chat.openai.com"],
    methods: ["GET"],
  })
);

// -------------------- CONFIG --------------------
const GRAPH = "https://graph.facebook.com/v24.0";
const AD_ACCOUNT_ID = process.env.FB_AD_ACCOUNT_ID;
const ACCESS_TOKEN = process.env.FB_ACCESS_TOKEN;
const ACTION_SECRET = process.env.ACTION_SECRET;

// -------------------- HELPERS --------------------

// Normalize FB "path" to a safe string
function asPathString(p) {
  if (typeof p === "string") return p;
  if (Array.isArray(p)) return p.filter((x) => typeof x === "string").join(" > ");
  return "";
}

async function queryGraph({ q, limit }) {
  const url = new URL(`${GRAPH}/act_${AD_ACCOUNT_ID}/targetingsearch`);
  url.searchParams.set("type", "adinterest");
  url.searchParams.set("q", q);
  url.searchParams.set("limit", limit || 10);
  url.searchParams.set(
    "fields",
    "id,name,path,audience_size_lower_bound,audience_size_upper_bound"
  );
  url.searchParams.set("access_token", ACCESS_TOKEN);

  const response = await fetch(url);
  const json = await response.json();
  if (json.error) {
    throw Object.assign(new Error("Graph error"), { code: 400, payload: json });
  }
  return json.data || [];
}

function formatAudienceSize(lower, upper) {
  const format = (n) => {
    if (!n || isNaN(n)) return null;
    if (n >= 1_000_000_000)
      return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
    if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
    if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
    return `${n}`;
  };
  return lower && upper ? `${format(lower)}–${format(upper)}` : "—";
}

// ✅ Keep only Interest-type results (exclude behaviors/demographics)
function interestOnly(data = []) {
  return data.filter((item) => {
    const pathStr = asPathString(item.path);
    return (
      pathStr &&
      !/^behaviou?r/i.test(pathStr) &&
      !/^demographic/i.test(pathStr)
    );
  });
}

// 🧠 Smart suggestion generator using keyword + last valid paths
function getSmartSuggestions(keyword = "", lastPaths = []) {
  const lower = (keyword || "").toLowerCase();
  const baseSuggestions = [];

  // 1️⃣ Infer family from last known interest paths
  const families = lastPaths
    .map((p) => asPathString(p))
    .map((p) => {
      const parts = p.split(">");
      return parts.length > 1 ? parts[1].trim().toLowerCase() : null;
    })
    .filter(Boolean);

  if (families.includes("games") || lower.includes("game")) {
    baseSuggestions.push("PC game", "Mobile game", "Online game", "Gaming");
  } else if (families.includes("entertainment") || lower.includes("anime")) {
    baseSuggestions.push("Anime", "Manga", "Otaku", "Streaming");
  } else if (families.includes("technology") || lower.includes("tech")) {
    baseSuggestions.push("Computer hardware", "Gadget", "IT", "Software");
  }

  // 2️⃣ Keyword-based synonym families
  const SYNS = {
    pc: ["PC game", "Computer game", "Gaming PC"],
    mobile: ["Mobile game", "Smartphone gaming"],
    rpg: ["MMORPG", "Fantasy game"],
    moba: ["Dota 2", "League of Legends"],
    esports: ["Competitive gaming", "Pro tournaments"],
    game: ["Video game", "Online game", "Gaming", "เกมออนไลน์"],
  };
  for (const [k, v] of Object.entries(SYNS)) {
    if (lower.includes(k)) baseSuggestions.push(...v);
  }

  // 3️⃣ De-duplicate and limit
  const unique = [...new Set(baseSuggestions)];
  return unique.length ? unique.slice(0, 4) : ["gaming", "video game", "esports", "เกมออนไลน์"];
}

// -------------------- HEALTH CHECK --------------------
app.get("/health", (req, res) => {
  res.json({ status: "online", timestamp: new Date().toISOString() });
});

// -------------------- MAIN ENDPOINT --------------------
app.get("/fb/interests", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (ACTION_SECRET && authHeader !== `Bearer ${ACTION_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const q = req.query.q;
    const limit = Number(req.query.limit || 10);

    if (!q) return res.status(400).json({ error: "Missing parameter 'q'" });
    if (!AD_ACCOUNT_ID || !ACCESS_TOKEN)
      return res
        .status(500)
        .json({ error: "Server missing environment variables" });

    const data = await queryGraph({ q, limit });
    const interests = interestOnly(data);

    // 🧩 If no valid interests found → generate smart suggestions
    if (interests.length === 0) {
      return res.json({
        query: q,
        count: 0,
        items: [],
        suggestions: getSmartSuggestions(q, data.map((d) => d.path))
      });
    }

    // ✅ Format interest results
    const formatted = interests.map((item) => ({
      id: item.id,
      name: item.name,
      path: asPathString(item.path),
      size:
        formatAudienceSize(
          item.audience_size_lower_bound,
          item.audience_size_upper_bound
        ) || "—",
    }));

    res.json({
      query: q,
      count: formatted.length,
      items: formatted,
    });
  } catch (err) {
    console.error("Error fetching data:", err);
    res.status(err?.code || 500).json({
      error: err?.code === 400 ? "Bad Request" : "Internal Server Error",
      details: err.payload || err.message,
    });
  }
});

// -------------------- STATUS PAGE --------------------
app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>FB Interest Proxy</title>
        <style>
          body {
            font-family: system-ui, sans-serif;
            background: #f6f7fb;
            color: #333;
            text-align: center;
            padding: 50px;
          }
          h1 { color: #1877f2; margin-bottom: 10px; }
          .status {
            display: inline-block;
            padding: 10px 20px;
            border-radius: 8px;
            background: #eaf3ff;
            border: 1px solid #c8defc;
            color: #1877f2;
            font-weight: 600;
          }
          footer {
            margin-top: 30px;
            font-size: 13px;
            color: #666;
          }
        </style>
      </head>
      <body>
        <h1>✅ FB Interest Proxy</h1>
        <div class="status" id="status">Checking...</div>
        <p>Custom GPT connection check</p>
        <footer>Powered by Meta Graph API • Hosted on Vercel</footer>
        <script>
          async function checkHealth() {
            try {
              const res = await fetch("/health");
              await res.json();
              document.getElementById("status").innerText = "🟢 Online";
            } catch {
              document.getElementById("status").innerText = "🔴 Offline";
            }
          }
          checkHealth();
          setInterval(checkHealth, 30000);
        </script>
      </body>
    </html>
  `);
});

export default app;
