import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const server = new Server(
  { name: "fixture", version: "1" },
  { capabilities: { resources: { subscribe: true } } },
);
server.setRequestHandler(SubscribeRequestSchema, async (request) => {
  setTimeout(async () => {
    for (let i = 0; i < 10; i++) await server.sendResourceUpdated({ uri: request.params.uri });
    setTimeout(() => process.exit(0), 300);
  }, 800);
  return {};
});
await server.connect(new StdioServerTransport());
