import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { tools } from './tools';

/** Runs a request through the app itself, as if it had come in over HTTP. */
export type Forward = (request: Request) => Response | Promise<Response>;

const text = (value: string, isError = false) => ({
  isError,
  content: [{ type: 'text' as const, text: value }],
});

function serverFor(forward: Forward, authorization: string) {
  const server = new Server(
    { name: 'notifications', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.input, { io: 'input' }) as {
        type: 'object';
      },
    })),
  }));
  // A failure is a tool result the model can read, with the API's own message.
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const tool = tools.find((t) => t.name === params.name);
    if (!tool) return text(`Unknown tool ${params.name}`, true);
    const parsed = tool.input.safeParse(params.arguments ?? {});
    if (!parsed.success) {
      return text(
        JSON.stringify({
          errors: parsed.error.issues.map((i) => ({
            path: i.path.join('.') || '_',
            message: i.message,
          })),
        }),
        true,
      );
    }
    const { method, path, query, body } = tool.request(parsed.data);
    const url = new URL(`http://app${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined)
        url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    const res = await forward(
      new Request(url, {
        method,
        headers: {
          authorization,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
    return text(await res.text(), !res.ok);
  });
  return server;
}

// Stateless: every request gets its own server and transport.
export async function handleMcp(request: Request, forward: Forward) {
  const server = serverFor(forward, request.headers.get('authorization') ?? '');
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    void transport.close();
    void server.close();
  }
}
