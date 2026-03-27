import { z } from "zod";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import type { ToolDefinition } from "./registry";
import { appConfig } from "../config";
import { processUrl, checkSsrf } from "./web-utils";
import { logger } from "../logger";

const schema = z.object({
  url: z.string().url().describe("URL of the web page to fetch"),
  extractMode: z
    .enum(["readability", "raw"])
    .optional()
    .default("readability")
    .describe('Content extraction mode: "readability" (default) strips navigation/ads and returns the main article; "raw" converts the full page body to Markdown'),
});

/** Truncate text to maxChars without breaking mid-word. */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.lastIndexOf(" ", maxChars);
  return (cut > 0 ? text.slice(0, cut) : text.slice(0, maxChars)) + "…";
}

/** Convert HTML to Markdown using Turndown with sensible defaults. */
function htmlToMarkdown(html: string): string {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  // Preserve tables (turndown default strips them — use the GFM plugin approach via rule)
  // Fallback table rule: convert tables to plain text instead of requiring
  // the turndown-plugin-gfm package. This preserves content without imposing
  // an extra dependency; GFM table output can be added later if needed.
  td.addRule("table", {
    filter: ["table"],
    replacement(_content, node) {
      // Fall back to plain text for tables; the table structure is preserved inline
      return `\n\n${(node as HTMLElement).textContent?.replace(/\n{2,}/g, "\n")}\n\n`;
    },
  });
  return td.turndown(html);
}

export const toolDefinition: ToolDefinition = {
  name: "web-fetch",
  description:
    "Fetch a web page and return its content as clean Markdown. " +
    "Tracking parameters are stripped from the URL before fetching. " +
    "Private/internal IP addresses and blocklisted domains are rejected (SSRF protection). " +
    "Content is truncated to WEB_MAX_CONTENT_CHARS (default 20 000 characters).",
  schema,
  permissions: "cautious",
  execute: async ({ url, extractMode = "readability" }: { url: string; extractMode?: "readability" | "raw" }): Promise<string> => {
    // 1. Sanitize + synchronous policy checks
    const { cleanUrl, error: policyError } = processUrl(url);
    if (policyError) {
      return JSON.stringify({ error: policyError });
    }

    // 2. Async SSRF check (DNS resolution)
    const ssrfError = await checkSsrf(cleanUrl);
    if (ssrfError) {
      return JSON.stringify({ error: ssrfError });
    }

    logger.info({ tool: "web-fetch", url: cleanUrl, extractMode }, "web-fetch invoked");

    // 3. Fetch
    let rawHtml: string;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), appConfig.webFetchTimeoutMs);
      let response: Response;
      try {
        response = await fetch(cleanUrl, {
          headers: { "User-Agent": appConfig.webUserAgent },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        return JSON.stringify({ error: `HTTP ${response.status} ${response.statusText} for ${cleanUrl}` });
      }

      // Enforce max response size
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (contentLength > appConfig.webMaxResponseBytes) {
        return JSON.stringify({ error: `Response too large: ${contentLength} bytes (limit: ${appConfig.webMaxResponseBytes}).` });
      }

      // Stream + cap to avoid allocating the full body if it's enormous
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done || !value) break;
          totalBytes += value.length;
          if (totalBytes > appConfig.webMaxResponseBytes) {
            reader.cancel().catch(() => {});
            break;
          }
          chunks.push(value);
        }
      }
      rawHtml = Buffer.concat(chunks).toString("utf-8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `Fetch failed: ${message}` });
    }

    // 4. Parse HTML → extract content → convert to Markdown
    let markdown: string;
    let title = "";
    let byline: string | undefined;
    let excerpt: string | undefined;

    try {
      const dom = new JSDOM(rawHtml, { url: cleanUrl });

      if (extractMode === "readability") {
        const reader = new Readability(dom.window.document);
        const article = reader.parse();

        if (article) {
          title = article.title ?? "";
          byline = article.byline ?? undefined;
          excerpt = article.excerpt ?? undefined;
          markdown = htmlToMarkdown(article.content ?? "");
        } else {
          // Fallback: convert the full body
          const bodyHtml = dom.window.document.body?.innerHTML ?? rawHtml;
          markdown = htmlToMarkdown(bodyHtml);
          title = dom.window.document.title ?? "";
        }
      } else {
        // raw mode — convert the full body
        const bodyHtml = dom.window.document.body?.innerHTML ?? rawHtml;
        markdown = htmlToMarkdown(bodyHtml);
        title = dom.window.document.title ?? "";
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `Content extraction failed: ${message}` });
    }

    // 5. Truncate
    const truncated = truncate(markdown, appConfig.webMaxContentChars);

    logger.info({ tool: "web-fetch", url: cleanUrl, chars: truncated.length }, "web-fetch completed");

    return JSON.stringify({
      url: cleanUrl,
      title,
      markdown: truncated,
      ...(byline ? { byline } : {}),
      ...(excerpt ? { excerpt } : {}),
    });
  },
};
