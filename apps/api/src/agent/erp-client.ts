import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

export interface ReadTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCallResult {
  isError: boolean;
  data: unknown;
}

export interface ErpClient {
  /** MCP 서버가 읽기 전용으로 표시한 도구만 돌려준다. */
  listReadTools(): Promise<ReadTool[]>;
  call(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
  close(): Promise<void>;
}

export async function connectErp(url: string, token: string): Promise<ErpClient> {
  const client = new Client({ name: 'dojang-agent', version: '0.1.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );

  return {
    async listReadTools() {
      const { tools } = await client.listTools();
      return tools
        .filter((tool) => tool.annotations?.readOnlyHint === true)
        .map((tool) => ({
          name: tool.name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema as Record<string, unknown>,
        }));
    },
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const [first] = result.content as { type: string; text?: string }[];
      return {
        isError: result.isError === true,
        data: first?.text ? JSON.parse(first.text) : null,
      };
    },
    close: () => client.close(),
  };
}
