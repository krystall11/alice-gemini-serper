import test from "node:test";
import assert from "node:assert/strict";
import alice, { config } from "../netlify/functions/alice.mjs";

const endpoint = "https://example.netlify.app/api";

test("Netlify routes the webhook to /api and returns a health response", async () => {
  assert.equal(config.path, "/api");
  const response = await alice(new Request(endpoint));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal((await response.json()).service, "alice-gemini-serper");
});

test("Netlify returns a greeting in the Alice protocol on POST", async () => {
  const response = await alice(new Request(endpoint, {
    method: "POST",
    body: JSON.stringify({ session: { new: true }, request: { command: "" } })
  }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.version, "1.0");
  assert.match(body.response.text, /Привет/);
  assert.ok(body.session_state);
});

test("Netlify forwards stop and invalid method responses", async () => {
  const stop = await alice(new Request(endpoint, {
    method: "POST",
    body: JSON.stringify({ request: { command: "Пока" } })
  }));
  assert.equal((await stop.json()).response.end_session, true);

  const invalid = await alice(new Request(endpoint, { method: "PUT" }));
  assert.equal(invalid.status, 405);
  assert.equal(invalid.headers.get("Allow"), "GET, HEAD, POST");
  assert.equal((await invalid.json()).error, "Method not allowed");
});

test("Netlify HEAD response has no body", async () => {
  const response = await alice(new Request(endpoint, { method: "HEAD" }));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
});
