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

test("map changes save only map-rotation and read it back before completing", async () => {
  const calls: { url: unknown; options?: RequestInit }[] = [];
  let storedMap = "TO_Coxwell\nTO_Falmire";
  const client = new NitradoClient({
    token: "token", serviceId: "123",
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (options?.method === "POST") {
        assert.deepEqual(JSON.parse(options.body as string), { category: "config", key: "map-rotation", value: "FFA_Duelyard" });
        storedMap = "FFA_Duelyard";
        return Response.json({ status: "success" });
      }
      return Response.json({ status: "success", data: { settings: { config: { "map-rotation": storedMap } } } });
    },
  });
  await client.setMapRotation(["FFA_Duelyard"]);
  assert.deepEqual(calls.map(({ url, options }) => [url, options?.method]), [
    ["https://api.nitrado.net/services/123/gameservers/settings", "POST"],
    ["https://api.nitrado.net/services/123/gameservers/settings", "GET"],
  ]);
  assert.equal(calls[1].options?.body, undefined);
  for (const { options } of calls) {
    assert.deepEqual(options?.headers, { Authorization: "Bearer token", "Content-Type": "application/json" });
    assert.equal(options?.redirect, "error");
    assert.ok(options?.signal instanceof AbortSignal);
  }
});

test("missing, malformed and mismatched saved settings never confirm a map change", async () => {
  for (const data of [undefined, {}, { settings: {} }, { settings: { config: {} } },
    { settings: { config: { "map-rotation": "TO_Coxwell" } } },
    { settings: { config: { "map-rotation": ["FFA_Duelyard"] } } },
  ]) {
    const methods: string[] = [];
    const client = new NitradoClient({ token: "token", serviceId: "123", fetch: async (_url, options) => {
      methods.push(options!.method!);
      return Response.json({ status: "success", data });
    } });
    await assert.rejects(client.setMapRotation(["FFA_Duelyard"]), /некорректную ротацию карт|не подтвердил сохранение ротации карт/);
    assert.deepEqual(methods, ["POST", "GET"]);
  }
});

test("failed map save requests are never retried or followed by verification", async () => {
  for (const response of [
    () => new Response("secret token", { status: 403 }),
    () => Response.json({ status: "error", message: "secret token" }),
    () => { throw new Error("secret token"); },
  ]) {
    let requests = 0;
    const client = new NitradoClient({ token: "secret token", serviceId: "123", fetch: async () => {
      requests++;
      return response();
    } });
    await assert.rejects(client.setMapRotation(["FFA_Duelyard"]), (error: Error) => {
      assert.ok(!error.message.includes("secret token"));
      return true;
    });
    assert.equal(requests, 1);
  }
});

test("failed map readback never repeats the save POST", async () => {
  const methods: string[] = [];
  const client = new NitradoClient({ token: "token", serviceId: "123", fetch: async (_url, options) => {
    methods.push(options!.method!);
    if (options?.method === "GET") throw new Error("connection failed");
    return Response.json({ status: "success" });
  } });
  await assert.rejects(client.setMapRotation(["FFA_Duelyard"]), /Нет ответа от API Nitrado/);
  assert.deepEqual(methods, ["POST", "GET"]);
});

test("rotations replace the old list with one map per line in order and preserve duplicates", async () => {
  for (const { maps, expected } of [
    { maps: ["TO_Coxwell", "TO_Lionspire", "TO_RudhelmSiege"], expected: "TO_Coxwell\nTO_Lionspire\nTO_RudhelmSiege" },
    { maps: ["TO_Falmire", "TO_DarkForest", "TO_Falmire"], expected: "TO_Falmire\nTO_DarkForest\nTO_Falmire" },
  ]) {
    let storedRotation = "FFA_Duelyard\nFFA_Courtyard";
    const methods: string[] = [];
    const client = new NitradoClient({ token: "token", serviceId: "123", fetch: async (_url, options) => {
      methods.push(options!.method!);
      if (options?.method === "POST") {
        const body = JSON.parse(options.body as string);
        assert.deepEqual(body, { category: "config", key: "map-rotation", value: expected });
        storedRotation = body.value;
        return Response.json({ status: "success" });
      }
      return Response.json({ status: "success", data: { settings: { config: { "map-rotation": storedRotation.replace(/\n/g, "\r\n") + "\r\n" } } } });
    } });
    await client.setMapRotation(maps);
    assert.equal(storedRotation, expected);
    assert.deepEqual(methods, ["POST", "GET"]);
  }
});

test("rotation verification rejects missing maps, extra maps, changed order and removed duplicates", async () => {
  const maps = ["TO_Falmire", "TO_DarkForest", "TO_Falmire"];
  for (const saved of [
    "TO_Falmire",
    "TO_Falmire\nTO_DarkForest",
    "TO_DarkForest\nTO_Falmire\nTO_Falmire",
    "TO_Falmire\nTO_DarkForest\nTO_Falmire\nTO_Coxwell",
  ]) {
    const methods: string[] = [];
    const client = new NitradoClient({ token: "token", serviceId: "123", fetch: async (_url, options) => {
      methods.push(options!.method!);
      return Response.json({ status: "success", data: { settings: { config: { "map-rotation": saved } } } });
    } });
    await assert.rejects(client.setMapRotation(maps), /не подтвердил сохранение ротации карт/);
    assert.deepEqual(methods, ["POST", "GET"]);
  }
});

test("an empty rotation cannot clear the map list", async () => {
  const client = new NitradoClient({ token: "token", serviceId: "123", fetch: async () => { assert.fail("unexpected API call"); } });
  await assert.rejects(client.setMapRotation([]), /Укажите хотя бы одну карту/);
});

test("current rotation is read without mutations and preserves order and repeats across line endings", async () => {
  const calls: { url: unknown; options?: RequestInit }[] = [];
  const client = new NitradoClient({ token: "token", serviceId: "123", fetch: async (url, options) => {
    calls.push({ url, options });
    return Response.json({ status: "success", data: { settings: { config: { "map-rotation": "  TO_Falmire \r\n\r\n TO_DarkForest\nTO_Falmire\r\n" } } } });
  } });
  assert.deepEqual(await client.getMapRotation(), ["TO_Falmire", "TO_DarkForest", "TO_Falmire"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.nitrado.net/services/123/gameservers/settings");
  assert.equal(calls[0].options?.method, "GET");
  assert.equal(calls[0].options?.body, undefined);
});

test("empty saved rotations are readable while malformed settings cannot be mistaken for an empty list", async () => {
  for (const saved of ["", " \r\n\n "]) {
    const client = new NitradoClient({ token: "token", serviceId: "123", fetch: async () =>
      Response.json({ status: "success", data: { settings: { config: { "map-rotation": saved } } } }) });
    assert.deepEqual(await client.getMapRotation(), []);
  }
  for (const data of [undefined, {}, { settings: {} }, { settings: { config: {} } }, { settings: { config: { "map-rotation": ["FFA_Duelyard"] } } }]) {
    const client = new NitradoClient({ token: "token", serviceId: "123", fetch: async () => Response.json({ status: "success", data }) });
    await assert.rejects(client.getMapRotation(), /некорректную ротацию карт/);
  }
});
