import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { safeFetch } from "./index";

describe("safeFetch", () => {
  it("blocks a redirect onto the metadata address", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/hop") {
        response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
        response.end();
        return;
      }
      response.writeHead(200);
      response.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    await expect(
      safeFetch({
        url: `http://127.0.0.1:${address.port}/hop`,
        policy: { allowLoopback: true, allowPrivate: true },
      }),
    ).rejects.toThrow(/blocked|metadata/i);
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
});
