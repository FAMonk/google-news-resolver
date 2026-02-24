// server.js (CommonJS)
const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

// --- simple in-process queue: 1 resolve at a time (prevents rapid-fire 429s)
let active = 0;
const waitForTurn = async () => {
  while (active >= 1) {
    await new Promise((r) => setTimeout(r, 250));
  }
  active += 1;
};
const doneTurn = () => {
  active = Math.max(0, active - 1);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeGoogleNewsUrl(input) {
  if (!input || typeof input !== "string") return input;

  // Convert RSS wrapper to article wrapper (much more likely to contain outbound link)
  let url = input.replace(
    "https://news.google.com/rss/articles/",
    "https://news.google.com/articles/"
  );

  // Some feeds use http
  url = url.replace(
    "http://news.google.com/rss/articles/",
    "https://news.google.com/articles/"
  );

  // If someone passes news.google.com/rss/.. without scheme changes, still ok.
  url = url.replace("/rss/articles/", "/articles/");

  return url;
}

function pickUserAgent() {
  // Keep it stable-ish; swap occasionally if you want
  return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
}

async function resolveOnce(targetUrl) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  const context = await browser.newContext({
    userAgent: pickUserAgent(),
    locale: "en-GB",
    timezoneId: "Europe/London",
    extraHTTPHeaders: {
      "Accept-Language": "en-GB,en;q=0.9",
    },
  });

  // Block heavy resources
  await context.route("**/*", (route) => {
    const req = route.request();
    const type = req.resourceType();
    if (type === "image" || type === "font" || type === "media") {
      return route.abort();
    }
    return route.continue();
  });

  const page = await context.newPage();

  let resp = null;
  let status = null;
  let finalUrl = null;

  try {
    resp = await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    status = resp ? resp.status() : null;

    // If Google is slow / cold-start / consent, give it a moment
    await page.waitForTimeout(1500);
    try {
      await page.waitForLoadState("networkidle", { timeout: 8000 });
    } catch (_) {}

    finalUrl = page.url();

    // If we got redirected out to publisher, we’re done
    if (finalUrl && !finalUrl.includes("news.google.com")) {
      return {
        ok: true,
        resolved_url: finalUrl,
        method: "final_url",
        http_status: status,
        final_url: finalUrl,
      };
    }

    // Try to extract outbound link from DOM
    const outbound = await page.evaluate(() => {
      const bad = (h) =>
        !h ||
        h.includes("news.google.com") ||
        h.includes("accounts.google.com") ||
        h.startsWith("javascript:");

      // Common Google News outbound patterns
      const selectors = [
        'a[href^="http"][rel="nofollow"]',
        'a[href^="http"][target="_blank"]',
        'article a[href^="http"]',
        'main a[href^="http"]',
        'a[href^="http"]',
      ];

      for (const sel of selectors) {
        const links = Array.from(document.querySelectorAll(sel))
          .map((a) => a.href)
          .filter((h) => !bad(h));
        if (links.length) return links[0];
      }
      return null;
    });

    if (outbound) {
      return {
        ok: true,
        resolved_url: outbound,
        method: "dom_link",
        http_status: status,
        final_url: finalUrl,
      };
    }

    // Nothing found
    return {
      ok: true,
      resolved_url: null,
      method: "none",
      http_status: status,
      final_url: finalUrl,
    };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function resolveWithRetries(googleNewsUrl) {
  const targetUrl = normalizeGoogleNewsUrl(googleNewsUrl);

  const maxAttempts = 4;
  let last = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // jitter + backoff to reduce 429
    const baseDelay = 800 * Math.pow(2, attempt - 1);
    const jitter = Math.floor(Math.random() * 400);
    if (attempt > 1) await sleep(baseDelay + jitter);

    last = await resolveOnce(targetUrl);

    // Success conditions
    if (last.resolved_url) return { ...last, attempt, target_url: targetUrl };

    // If Google blocked us, try again (429/503)
    if (last.http_status === 429 || last.http_status === 503) {
      continue;
    }

    // If it’s 200 but no link, retries usually won’t help
    break;
  }

  return { ...last, attempt: maxAttempts, target_url: targetUrl };
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

  await waitForTurn();
  try {
    const result = await resolveWithRetries(google_news_url);

    // Flag likely block for easier debugging upstream
    const blocked = result.http_status === 429;

    res.json({
      ok: true,
      google_news_url,
      blocked,
      ...result,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      google_news_url,
      error: err?.message || String(err),
    });
  } finally {
    doneTurn();
  }
});

app.listen(PORT, () => console.log(`google-news-resolver listening on :${PORT}`));
