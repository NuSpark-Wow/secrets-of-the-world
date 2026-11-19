// The Secrets of the World — photo pointers
// Looks at a Wikimedia photo and decides where arrows should point.
// Honesty rule: if it isn't confident where something is, it returns low confidence
// and the page shows a label instead of an arrow pointing at the wrong spot.

const MODEL = process.env.ANNOTATE_MODEL || "claude-haiku-5-5";
const DAILY_LIMIT = parseInt(process.env.DAILY_PHOTO_LIMIT || "80", 10);
const ALLOWED = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);

const hits = new Map();
function overLimit(ip, limit) {
  const key = ip + "|" + new Date().toISOString().slice(0, 10);
  const n = (hits.get(key) || 0) + 1;
  hits.set(key, n);
  if (hits.size > 5000) hits.clear();
  return n > limit;
}
const cache = new Map(); // same photo + labels = same answer, no repeat cost on a warm server

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const origin = req.headers.origin || "";
  if (ALLOWED.length && origin && !ALLOWED.some(a => origin === a)) return res.status(403).json({ error: "forbidden" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "missing key" });

  const b = req.body || {};
  const imageUrl = String(b.imageUrl || "");
  let host = "";
  try { host = new URL(imageUrl).hostname; } catch (e) {}
  if (host !== "upload.wikimedia.org") return res.status(400).json({ error: "Only Wikimedia photos are allowed." });
  const labels = (Array.isArray(b.labels) ? b.labels : []).slice(0, 3).map(l => String(l).slice(0, 80));
  if (!labels.length) return res.status(200).json({ points: [] });
  const subject = String(b.subject || "").slice(0, 200);

  const key = imageUrl + "|" + labels.join("|");
  if (cache.has(key)) return res.status(200).json(cache.get(key));

  const ip = String(req.headers["x-forwarded-for"] || "x").split(",")[0].trim();
  if (overLimit(ip, DAILY_LIMIT)) return res.status(429).json({ error: "limit" });

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 600,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "url", url: imageUrl } },
            { type: "text", text:
`This photo illustrates: "${subject}".
For each label below, find the spot in the photo the label is about and give its position as percentages of the image width (x, 0=left, 100=right) and height (y, 0=top, 100=bottom).
Rate your confidence from 0 to 1. Only give 0.7 or higher if the thing is clearly visible and you are sure of the spot. If the label describes something hidden or not visible (like organs inside an animal), point to the visible part of the body where it is located, and keep confidence at 0.7 or lower unless that body part is clearly visible.
Labels:
${labels.map((l, i) => (i + 1) + ". " + l).join("\n")}
Reply with ONLY JSON: {"points":[{"label":"...","x":0,"y":0,"confidence":0}]}` }
          ]
        }]
      })
    });
    if (!r.ok) throw new Error("API " + r.status);
    const data = await r.json();
    const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    const a = text.indexOf("{"), z = text.lastIndexOf("}");
    let points = [];
    try { points = JSON.parse(text.slice(a, z + 1)).points || []; } catch (e) {}
    points = points.slice(0, 3).map((p, i) => ({
      label: labels[i] || String(p.label || "").slice(0, 80),
      x: Math.max(3, Math.min(97, Number(p.x) || 50)),
      y: Math.max(3, Math.min(97, Number(p.y) || 50)),
      confidence: Math.max(0, Math.min(1, Number(p.confidence) || 0))
    }));
    const out = { points };
    cache.set(key, out);
    if (cache.size > 2000) cache.clear();
    res.setHeader("Cache-Control", "s-maxage=2592000");
    return res.status(200).json(out);
  } catch (e) {
    console.error(e);
    return res.status(200).json({ points: [] });
  }
};
