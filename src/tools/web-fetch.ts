import { z } from "zod";
import { appConfig } from "../config";
import { logger } from "../logger";
import type { ToolDefinition } from "./registry";
import {
  sanitizeUrl,
  checkProtocol,
  checkBlocklist,
  checkAllowlist,
  checkSsrf,
  fetchWithLimits,
  extractReadable,
  extractBodyHtml,
  extractTitle,
  htmlToMarkdown,
  truncateAtWordBoundary,
} from "./web-utils";

const schema = z.object({
  url: z.string().url().describe("The URL of the web page to fetch and extract content from"),
  extractMode: z
    .enum(["readability", "raw"])
    .optional()
    .default("readability")
    .describe(
      'Content extraction mode: "readability" (default) uses Mozilla Readability to extract ' +
        'the main article content (strips nav, ads, sidebars); "raw" converts the full <body> to Markdown'
    ),
});

/** Structured result returned by the web-fetch tool. */
interface WebFetchResult {
  /** The cleaned URL that was actually fetched (tracking params stripped) */
  url: string;
  /** Page title extracted by Readability, or <title> tag as fallback */
  title: string;
  /** The main content converted to Markdown, truncated to WEB_MAX_CONTENT_CHARS */
  markdown: string;
  /** Article author (when available from Readability) */
  byline?: string;
  /** Short excerpt (when available from Readability) */
  excerpt?: string;
  /** Length of the original Markdown before truncation */
  originalLength: number;
  /** Whether the content was truncated */
  truncated: boolean;
}

/** Error object returned when the fetch pipeline fails. */
interface WebFetchError {
  error: string;
  url: string;
}

export const toolDefinition: ToolDefinition = {
  name: "web_fetch",
  description:
    "Fetch a public web page by URL and return its main content as Markdown. " +
    "Strips tracking parameters, enforces security checks (SSRF protection, domain blocklist/allowlist), " +
    "and converts HTML to clean Markdown via Mozilla Readability + Turndown. " +
    "Use this after a search() call to read the content of a specific URL.",
  schema,
  permissions: "cautious",
  execute: async ({
    url,
    extractMode = "readability",
  }: {
    url: string;
    extractMode?: "readability" | "raw";
  }): Promise<string> => {
    logger.debug({ tool: "web_fetch", url, extractMode }, "web_fetch invoked");

    // 1. Sanitize — strip tracking parameters
    const cleanUrl = sanitizeUrl(url);
    let parsed: URL;
    try {
      parsed = new URL(cleanUrl);
    } catch {
      const err: WebFetchError = { error: `Invalid URL: ${url}`, url: cleanUrl };
      return JSON.stringify(err);
    }

    // 2. Security checks — each throws on violation; caught and returned as error JSON
    try {
      checkProtocol(cleanUrl, appConfig.webAllowHttp);
      checkBlocklist(parsed.hostname, appConfig.webDomainBlocklist);
      checkAllowlist(parsed.hostname, appConfig.webDomainAllowlist);
      await checkSsrf(parsed.hostname);
    } catch (err: any) {
      const result: WebFetchError = { error: err.message, url: cleanUrl };
      logger.warn({ tool: "web_fetch", url: cleanUrl, error: err.message }, "web_fetch blocked by security check");
      return JSON.stringify(result);
    }

    // 3. Fetch the page
    let html: string;
    try {
      html = await fetchWithLimits(cleanUrl, {
        timeoutMs: appConfig.webFetchTimeoutMs,
        userAgent: appConfig.webUserAgent,
        maxBytes: appConfig.webMaxResponseBytes,
      });
    } catch (err: any) {
      const result: WebFetchError = { error: `Fetch failed: ${err.message}`, url: cleanUrl };
      logger.warn({ tool: "web_fetch", url: cleanUrl, error: err.message }, "web_fetch network error");
      return JSON.stringify(result);
    }

    // 4. Extract content
    const extracted = extractMode === "readability" ? extractReadable(html, cleanUrl) : null;
    const contentHtml = extracted?.content ?? extractBodyHtml(html);
    const title = extracted?.title || extractTitle(html) || parsed.hostname;

    // 5. Convert to Markdown and truncate
    const rawMarkdown = htmlToMarkdown(contentHtml);
    const { text: markdown, truncated } = truncateAtWordBoundary(rawMarkdown, appConfig.webMaxContentChars);

    const result: WebFetchResult = {
      url: cleanUrl,
      title,
      markdown,
      byline: extracted?.byline ?? undefined,
      excerpt: extracted?.excerpt ?? undefined,
      originalLength: rawMarkdown.length,
      truncated,
    };

    logger.debug(
      { tool: "web_fetch", url: cleanUrl, title, truncated, originalLength: rawMarkdown.length },
      "web_fetch completed"
    );
    return JSON.stringify(result);
  },
};
