/**
 * MCP サーバの **実 HTTP 経路** を SDK の StreamableHTTPClientTransport で叩く診断スクリプト。
 * = Claude Code が使うのと同じトランスポートで /api/mcp に接続し、tools/list + 1 call を試す。
 * Usage (container 内): npx tsx scripts/test-mcp-http.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getMcpToken } from "@/lib/mcp-token";
import { deleteNote } from "@/lib/notes";

async function main() {
  const token = await getMcpToken();
  const url = new URL("http://localhost:3000/api/mcp");
  console.log("[http-test] connecting to", url.toString());

  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "http-diag", version: "0.0.0" });

  try {
    await client.connect(transport);
    console.log("[http-test] connected ✓");

    const tools = await client.listTools();
    console.log("[http-test] tools:", tools.tools.map((t) => t.name).join(", "));

    const res = (await client.callTool({
      name: "note_create",
      arguments: { body_md: "# HTTP 診断\n\nreal transport テスト", title: "HTTP 診断" },
    })) as { structuredContent?: { id?: number } };
    const id = Number(res.structuredContent?.id);
    console.log("[http-test] note_create ->", JSON.stringify(res.structuredContent));
    if (id > 0) await deleteNote(id).catch(() => {});

    await client.close();
    console.log("✅ HTTP transport OK");
    process.exit(0);
  } catch (e) {
    console.error("❌ HTTP transport FAILED:", e instanceof Error ? e.stack : e);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[http-test] threw:", e);
  process.exit(1);
});
