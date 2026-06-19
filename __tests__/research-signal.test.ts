import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { detectExternalResearchSignal } from "../src/lib/research-signal.js";

describe("detectExternalResearchSignal", () => {
  test("URL in research context signals external research", () => {
    const result = detectExternalResearchSignal("Check https://example.com/guide for the schema.");
    assert.equal(result.requires_external, true);
    assert.equal(result.reason, "url");
    assert.deepEqual(result.matches, ["https://example.com/guide"]);
  });

  test("self-contained URL and HTTP service wording does not signal external research", () => {
    const result = detectExternalResearchSignal(
      "Build a self-contained HTTP REST service. Use URL inputs for POST /shorten, redirect GET /:code to the stored original URL, and expose GET /stats from local in-memory state.",
    );
    assert.equal(result.requires_external, false);
    assert.equal(result.reason, null);
    assert.deepEqual(result.matches, []);
  });

  test("pure local content does not signal external research", () => {
    const result = detectExternalResearchSignal("Add a lowStockThreshold field to the inventory API.");
    assert.equal(result.requires_external, false);
    assert.equal(result.reason, null);
    assert.deepEqual(result.matches, []);
  });

  test("explicit external-research request signals via explicit reason", () => {
    const result = detectExternalResearchSignal("Perform external research on the packaging conventions.");
    assert.equal(result.requires_external, true);
    assert.equal(result.reason, "explicit");
  });

  test("external-reference intent (replicate/clone/match/align/port) signals via intent reason", () => {
    const replicate = detectExternalResearchSignal("Replicate the external alert guide behavior in the new module.");
    assert.equal(replicate.requires_external, true);
    assert.equal(replicate.reason, "intent");

    const port = detectExternalResearchSignal("Port from an external library to keep parity.");
    assert.equal(port.requires_external, true);
    assert.equal(port.reason, "intent");

    const align = detectExternalResearchSignal("Align with an external API contract.");
    assert.equal(align.requires_external, true);
    assert.equal(align.reason, "intent");
  });

  test("external data and third-party API requests signal via explicit reason", () => {
    const scrape = detectExternalResearchSignal("Fetch external website data every night and extract the latest listings.");
    assert.equal(scrape.requires_external, true);
    assert.equal(scrape.reason, "explicit");

    const api = detectExternalResearchSignal("Integrate with an unknown third-party billing API before generating invoices.");
    assert.equal(api.requires_external, true);
    assert.equal(api.reason, "explicit");
  });

  test("URL reason takes precedence over explicit and intent", () => {
    const result = detectExternalResearchSignal("Use external research from https://example.com to replicate behavior.");
    assert.equal(result.requires_external, true);
    assert.equal(result.reason, "url");
  });

  test("empty or whitespace content does not signal", () => {
    assert.equal(detectExternalResearchSignal("").requires_external, false);
    assert.equal(detectExternalResearchSignal("   \n  ").requires_external, false);
    assert.equal(detectExternalResearchSignal().requires_external, false);
  });

  test("background mention of external research without request verb does not signal", () => {
    const result = detectExternalResearchSignal("Verify project evidence while allowing external research as background only.");
    assert.equal(result.requires_external, false);
  });

  test("negative scope boundary mentioning web UI does not request external research", () => {
    const result = detectExternalResearchSignal("Do not build a web UI; keep this as a local command-line tool.");
    assert.equal(result.requires_external, false);

    const scoped = detectExternalResearchSignal("Use Node and TypeScript only; persist to a local JSON file. Do not build a web UI, network service, database server, authentication, or sync feature.");
    assert.equal(scoped.requires_external, false);
  });

  test("negative external API and scraping boundaries do not request external research", () => {
    const result = detectExternalResearchSignal("No external API calls, scraping, authentication, or deployed web hosting.");
    assert.equal(result.requires_external, false);
  });

  test("multiple text sources are joined and scanned together", () => {
    const result = detectExternalResearchSignal("Add a field.", "See https://example.com for reference.");
    assert.equal(result.requires_external, true);
    assert.equal(result.reason, "url");
  });
});
