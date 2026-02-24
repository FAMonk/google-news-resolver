import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

async function resolveGoogleNewsUrl(googleNewsUrl) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-gpu"],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();

  try {
    const resp = await page.goto(googleNewsUrl, { waitUntil: "domcontentloaded", timeout: 25000 });

    await page.waitForTimeout(1500);

    try { await page.waitForLoadState("networkidle", { timeout: 8000 }); } catch {}

    const finalUrl = page.url();

    if (finalUrl && !finalUrl.includes("news.google.com")) {
      return { resolved_url: finalUrl, method: "final_url", http_status: resp?.status?.() ?? null };
    }

    const outbound = await page.evaluate(() => {
      const selectors = [
        'a[rel="nofollow"]',
        'a[target="_blank"]',
        'article a[href^="http"]',
        'main a[href^="http"]',
      ];
      for (const sel of selectors) {
        const a = document.querySelector(sel);
        if (a && a.href) return a.href;
      }
      const links = Array.from(document.querySelectorAll("a[href^='http']"))
        .map(a => a.href)
        .filter(h => h && !h.includes("news.google.com") && !h.includes("accounts.google.com"));
      return links[0] || null;
    });

    if (outbound) {
      return { resolved_url: outbound, method: "dom_link", http_status: resp?.status?.() ?? null };
    }

    return { resolved_url: null, method: "none", http_status: resp?.status?.() ?? null };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "google-news-resolver", time: new Date().toISOString() });
});

app.post("/resolve", async (req, res) => {
  const google_news_url = req.body?.google_news_url;
  if (!google_news_url || typeof google_news_url !== "string") {
    return res.status(400).json({
      ok: false,
      error: "Missing google_news_url (string) in JSON body",
      example: { google_news_url: "https://news.google.com/rss/articles/CBMi... ?oc=5" },
    });
  }

  try {
    const result = await resolveGoogleNewsUrl(google_news_url);
    res.json({ ok: true, google_news_url, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, google_news_url, error: err?.message || String(err) });
  }
});

app.listen(PORT, () => console.log(`google-news-resolver listening on :${PORT}`));
