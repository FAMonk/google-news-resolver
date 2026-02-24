# Google News Resolver (Playwright) — Docker/Render Friendly

This version fixes Render build failures caused by `playwright install --with-deps` (needs sudo).
It uses the official Playwright Docker base image which already includes OS dependencies.

## Endpoints
- GET `/health`
- POST `/resolve` with JSON `{ "google_news_url": "https://news.google.com/rss/articles/..." }`

## Deploy to Render (Docker)
1. Create a new **Web Service**
2. Choose **Docker** environment
3. Point it at this repo
4. Deploy

## Test with curl
```bash
curl -s -X POST "https://YOUR-SERVICE.onrender.com/resolve"   -H "Content-Type: application/json"   -d '{"google_news_url":"https://news.google.com/rss/articles/CBMi..."}'
```
