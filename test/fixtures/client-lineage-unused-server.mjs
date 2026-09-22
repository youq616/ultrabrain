// The CLI statically imports its MCP server. Lineage must never instantiate it.
export class Server{constructor(){throw Error('Lineage must not start an MCP server');}}
export class StdioServerTransport{constructor(){throw Error('Lineage must not start a server transport');}}
export const CallToolRequestSchema={},ListToolsRequestSchema={},ErrorCode={};
export class McpError extends Error{}
