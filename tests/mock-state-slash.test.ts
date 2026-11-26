import { expect, test } from "bun:test";
import type { OpenApiSpec } from "../src/mockServer/loadSpec";
import { startServer } from "../src/mockServer/server";

function specFor(collections: string[]): OpenApiSpec {
  const responses = {
    "200": {
      description: "success",
      content: { "application/json": { schema: {} } },
    },
    "404": { description: "not found" },
  };
  const query = {
    name: "node_type",
    in: "query",
    required: true,
    schema: { type: "string" },
  };
  const requestBody = {
    required: true,
    content: {
      "application/json": { schema: { type: "object", additionalProperties: true } },
    },
  };
  return {
    openapi: "3.0.0",
    info: { title: "Trailing slash regression", version: "1" },
    paths: {
      ...Object.fromEntries(
        collections.map((path) => [
          path,
          {
            get: { parameters: [query], responses },
            post: { requestBody, responses },
          },
        ]),
      ),
      "/api/node/{node_id}": {
        parameters: [
          {
            name: "node_id",
            in: "path",
            required: true,
            schema: { type: "integer" },
          },
        ],
        get: { parameters: [query], responses },
        patch: { requestBody, responses },
        put: { requestBody, responses },
        delete: { parameters: [query], responses },
      },
    },
  } as unknown as OpenApiSpec;
}

for (const collection of ["/api/node", "/api/node/"]) {
  test(`${collection}: validated numeric CRUD round-trips and unknown IDs fail`, async () => {
    const server = await startServer({
      spec: specFor([collection]),
      port: 0,
      hostname: "127.0.0.1",
      stateful: true,
      validate: true,
      log: () => {},
    });
    const base = `http://127.0.0.1:${server.port}`;
    const entity = { id: 940041, node_id: 940041, name: "probe", node_type: "test" };
    const json = (method: string, body: unknown) => ({
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const item = `${base}/api/node/940041?node_type=test`;
    const list = `${base}${collection}?node_type=test`;
    try {
      expect((await fetch(list)).status).toBe(200);
      const created = await fetch(`${base}${collection}`, json("POST", entity));
      expect(created.status).toBe(200);
      expect(await created.json()).toEqual(entity);
      expect(await (await fetch(list)).json()).toEqual([entity]);
      expect(await (await fetch(item)).json()).toEqual(entity);
      expect((await fetch(`${base}/api/node/940041`)).status).toBe(422);
      expect((await fetch(`${base}/api/node/not-an-integer?node_type=test`)).status).toBe(422);
      for (const method of ["GET", "PATCH", "PUT", "DELETE"]) {
        const response = await fetch(
          `${base}/api/node/940042?node_type=test`,
          method === "PATCH" || method === "PUT" ? json(method, { name: "missing" }) : { method },
        );
        expect(response.status).toBe(404);
      }
      for (const method of ["PATCH", "PUT"]) {
        const updated = { ...entity, name: method };
        const response = await fetch(item, json(method, { name: method }));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(updated);
        expect(await (await fetch(item)).json()).toEqual(updated);
        expect(await (await fetch(list)).json()).toEqual([updated]);
      }
      expect((await fetch(item, { method: "DELETE" })).status).toBe(204);
      expect((await fetch(item)).status).toBe(404);
      expect(await (await fetch(list)).json()).toEqual([]);
      const other = collection.endsWith("/") ? collection.slice(0, -1) : `${collection}/`;
      expect((await fetch(`${base}${other}?node_type=test`)).status).toBe(404);
      expect(await server.backend.has(collection)).toBe(true);
    } finally {
      await server.stop();
    }
  });
}

for (const collections of [
  ["/api/node/", "/api/node"],
  ["/api/node", "/api/node/"],
]) {
  test(`distinct collections remain isolated (${collections.join(", ")})`, async () => {
    const server = await startServer({
      spec: specFor(collections),
      port: 0,
      hostname: "127.0.0.1",
      stateful: true,
      validate: true,
      log: () => {},
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      for (const path of collections) {
        const response = await fetch(`${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: 940041, name: path }),
        });
        expect(response.status).toBe(200);
      }
      const item = `${base}/api/node/940041?node_type=test`;
      expect(await (await fetch(item)).json()).toEqual({ id: 940041, name: "/api/node" });
      expect((await fetch(item, { method: "DELETE" })).status).toBe(204);
      expect(await (await fetch(`${base}/api/node?node_type=test`)).json()).toEqual([]);
      expect(await (await fetch(`${base}/api/node/?node_type=test`)).json()).toEqual([
        { id: 940041, name: "/api/node/" },
      ]);
    } finally {
      await server.stop();
    }
  });
}
