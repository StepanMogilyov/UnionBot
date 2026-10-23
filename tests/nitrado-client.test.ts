import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NitradoClient } from "../src/nitrado-client";

test("Nitrado uses the configured service, bearer authentication and a single restart POST", async () => {
  const calls: { url: unknown; options?: RequestInit }[] = [];
  const client = new NitradoClient({
    token: " token ", serviceId: " 123 ",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ status: "success", data: { gameserver: { status: "started" } } });
    },
  });
  assert.equal(await client.getStatus(), "started");
  await client.restart("Discord user 42");
  assert.deepEqual(calls.map(({ url, options }) => [url, options?.method]), [
    ["https://api.nitrado.net/services/123/gameservers", "GET"],
    ["https://api.nitrado.net/services/123/gameservers/restart", "POST"],
  ]);
  for (const { options } of calls) {
    assert.deepEqual(options?.headers, { Authorization: "Bearer token", "Content-Type": "application/json" });
    assert.ok(options?.signal instanceof AbortSignal);
    assert.equal(options?.redirect, "error");
  }
  assert.equal(calls[0].options?.body, undefined);
  assert.deepEqual(JSON.parse(calls[1].options?.body as string), { message: "Discord user 42" });
});

test("missing tokens and invalid service IDs disable restart without sending a request", async () => {
  for (const [token, serviceId] of [["", "123"], ["token", ""], ["token", "0"], ["token", "../123"], ["token", "ni123"]]) {
    const client = new NitradoClient({ token, serviceId, fetch: async () => { assert.fail("unexpected API call"); } });
    assert.equal(client.configured, false);
    await assert.rejects(client.restart("test"), /NITRADO_API_TOKEN/);
  }
});

test("HTTP failures, rejected payloads and broken connections never expose upstream secrets or retry POST", async () => {
  const responses = [
    () => new Response("secret token", { status: 401 }),
    () => new Response("secret token", { status: 403 }),
    () => new Response("secret token", { status: 404 }),
    () => new Response("secret token", { status: 429 }),
    () => new Response("secret token", { status: 503 }),
    () => Response.json({ status: "error", message: "secret token" }),
    () => new Response("secret token", { status: 200 }),
    () => { throw new Error("secret token"); },
  ];
  for (const response of responses) {
    let requests = 0;
    const client = new NitradoClient({ token: "secret token", serviceId: "123", fetch: async () => {
      requests++;
      return response();
    } });
    await assert.rejects(client.restart("test"), (error: Error) => {
      assert.ok(!error.message.includes("secret token"));
      return true;
    });
    assert.equal(requests, 1);
  }
});

test("invalid status responses cannot be mistaken for a running server", async () => {
  for (const data of [undefined, {}, { gameserver: {} }, { gameserver: { status: true } }]) {
    const client = new NitradoClient({ token: "token", serviceId: "123", fetch: async () => Response.json({ status: "success", data }) });
    await assert.rejects(client.getStatus(), /некорректное состояние/);
  }
});
