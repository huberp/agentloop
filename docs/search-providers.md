# Search Providers

The `search` tool supports four backend providers, selected via the `WEB_SEARCH_PROVIDER` environment variable.

```
WEB_SEARCH_PROVIDER=duckduckgo   # default
WEB_SEARCH_PROVIDER=tavily
WEB_SEARCH_PROVIDER=langsearch
WEB_SEARCH_PROVIDER=none
```

All providers return the same JSON array format: `[{ "title": "…", "link": "…", "snippet": "…" }]`.

---

## DuckDuckGo (default)

No API key required. Uses the [`duck-duck-scrape`](https://github.com/nicholasess/duck-duck-scrape) library to scrape DuckDuckGo results.

**Limitations:** DuckDuckGo rate-limits aggressive scrapers. Built-in retry, exponential back-off, and in-memory caching help mitigate this, but results can be unreliable under heavy usage.

### Configuration

| Variable | Default | Description |
|---|---|---|
| `DUCKDUCKGO_MAX_RESULTS` | `5` | Maximum results per query |
| `DUCKDUCKGO_MIN_DELAY_MS` | `1000` | Minimum ms between outbound requests (rate-limit guard) |
| `DUCKDUCKGO_RETRY_MAX` | `2` | Maximum retries on transient failure |
| `DUCKDUCKGO_RETRY_BASE_DELAY_MS` | `400` | Base delay for exponential back-off |
| `DUCKDUCKGO_RATE_LIMIT_PENALTY_MS` | `1000` | Extra delay added on HTTP 429 responses |
| `DUCKDUCKGO_CACHE_TTL_MS` | `300000` | In-memory cache TTL in ms (0 = disabled) |
| `DUCKDUCKGO_CACHE_MAX_ENTRIES` | `128` | Maximum cached queries (0 = disabled) |
| `DUCKDUCKGO_SERVE_STALE_ON_ERROR` | `true` | Serve stale cache when upstream fails |

### Setup

No sign-up required. Set `WEB_SEARCH_PROVIDER=duckduckgo` (or leave it unset — it is the default).

---

## Tavily

[Tavily](https://tavily.com) is a search API purpose-built for AI applications. It provides clean, relevant results with minimal noise and is considerably more reliable than DuckDuckGo scraping.

**Free tier:** Tavily offers a generous free tier (1,000 searches/month). Paid plans are available for higher volumes.

### Setup

1. Sign up at <https://app.tavily.com/home>
2. Copy your API key from the dashboard
3. Add to your `.env`:

   ```env
   WEB_SEARCH_PROVIDER=tavily
   TAVILY_API_KEY=tvly-xxxxxxxxxxxxxxxxxxxxxxxx
   ```

### Configuration

| Variable | Default | Description |
|---|---|---|
| `TAVILY_API_KEY` | _(required)_ | API key from app.tavily.com |
| `TAVILY_MAX_RESULTS` | `5` | Maximum results per query |

### Notes

- Results come from the `content` field of the Tavily response, which contains an AI-extracted summary of the page — usually more informative than a raw snippet.
- The `search_depth` is set to `"basic"` for speed. You can change this to `"advanced"` if you need deeper results (consumes more API credits).

---

## LangSearch

[LangSearch](https://langsearch.com) is a search API optimised for LLM and agentic workflows, offering real-time web results via a simple REST API.

### Setup

1. Sign up at <https://langsearch.com/>
2. Obtain your API key
3. Add to your `.env`:

   ```env
   WEB_SEARCH_PROVIDER=langsearch
   LANGSEARCH_API_KEY=your-langsearch-api-key
   ```

### Configuration

| Variable | Default | Description |
|---|---|---|
| `LANGSEARCH_API_KEY` | _(required)_ | API key from langsearch.com |
| `LANGSEARCH_MAX_RESULTS` | `5` | Maximum results per query (`count` in the API) |

### Notes

- Results come from `webPages.value[].snippet` in the LangSearch response.
- The `freshness` parameter is set to `"noLimit"` by default (no date restriction).

---

## None (disabled)

Setting `WEB_SEARCH_PROVIDER=none` disables web search entirely. The tool returns an empty result array without making any network requests. This is useful for:

- Environments with no internet access
- Testing and CI pipelines where you want to prevent accidental outbound calls
- Profiles that should not have web access

```env
WEB_SEARCH_PROVIDER=none
```

---

## Caching

All providers share the same in-memory LRU cache. Cache behaviour is controlled by the `DUCKDUCKGO_CACHE_*` settings regardless of which provider is active. The cache is keyed by the exact query string and is scoped to a single process lifetime.

To disable caching:
```env
DUCKDUCKGO_CACHE_TTL_MS=0
DUCKDUCKGO_CACHE_MAX_ENTRIES=0
```

---

## Switching providers at runtime

`WEB_SEARCH_PROVIDER` is read from `appConfig` on every tool invocation, so it can be changed programmatically in tests or multi-profile setups without restarting the process:

```typescript
import { appConfig } from "./src/config";
appConfig.webSearchProvider = "tavily";
```
