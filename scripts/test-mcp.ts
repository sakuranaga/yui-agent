/**
 * ゆい MCP サーバ M1 のテスト (= tsx ベース)。
 * - mcp-token: 生成/暗号化保存/復号一致/timingSafeEqual/ローテート。
 * - note tools: MCP SDK の InMemoryTransport で Client↔Server を直結し、tool list / call を E2E 検証。
 *
 * Usage (container 内): npx tsx scripts/test-mcp.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerNoteTools } from "@/lib/mcp/tools-note";
import { getMcpToken, rotateMcpToken, verifyMcpToken } from "@/lib/mcp-token";
import { deleteNote } from "@/lib/notes";

let passed = 0;
const failures: string[] = [];
function check(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

type CallResult = { structuredContent?: Record<string, unknown>; isError?: boolean };

async function main() {
  const created: number[] = [];
  try {
    // --- 1. mcp-token ---
    console.log("[1] mcp-token");
    const tok = await getMcpToken();
    check(typeof tok === "string" && tok.length >= 40, `トークン生成 (len=${tok.length})`);
    check(await verifyMcpToken(tok), "正しいトークンは検証 OK");
    check(!(await verifyMcpToken(tok + "x")), "長さ違いは reject");
    check(!(await verifyMcpToken("nope")), "別トークンは reject");
    check(!(await verifyMcpToken(null)), "null は reject");
    check((await getMcpToken()) === tok, "再取得で同じ (= 永続化されている)");
    const rotated = await rotateMcpToken();
    check(rotated !== tok, "ローテートで新トークン");
    check(await verifyMcpToken(rotated), "新トークンは検証 OK");
    check(!(await verifyMcpToken(tok)), "旧トークンは即無効");

    // --- 2. MCP server: tool 登録 + E2E call ---
    console.log("[2] MCP note tools (InMemory E2E)");
    const server = new McpServer({ name: "yui-test", version: "0.0.0" });
    registerNoteTools(server);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    await client.connect(clientT);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    check(
      ["note_archive", "note_create", "note_get", "note_search", "note_update"].every((n) =>
        names.includes(n)
      ),
      `note tool 5 種が list される (${names.join(",")})`
    );

    // create
    const uniq = `MCPテスト用語_${Date.now()}_qqzz`;
    const createRes = (await client.callTool({
      name: "note_create",
      arguments: { body_md: `# MCP メモ\n\n${uniq} について。`, title: "MCP メモ" },
    })) as CallResult;
    const noteId = Number(createRes.structuredContent?.id);
    check(noteId > 0, `note_create で id 採番 (${noteId})`);
    if (noteId > 0) created.push(noteId);
    check(createRes.structuredContent?.title === "MCP メモ", "title が返る");

    // get
    const getRes = (await client.callTool({
      name: "note_get",
      arguments: { id: noteId },
    })) as CallResult;
    check(getRes.structuredContent?.found === true, "note_get found");
    check(
      String(getRes.structuredContent?.body_md ?? "").includes(uniq),
      "note_get 本文が一致"
    );

    // search (lexical)
    const searchRes = (await client.callTool({
      name: "note_search",
      arguments: { query: uniq },
    })) as CallResult;
    const sNotes = (searchRes.structuredContent?.notes ?? []) as Array<{ id: number }>;
    check(sNotes.some((n) => n.id === noteId), "note_search で作成ノートがヒット");

    // update
    const updRes = (await client.callTool({
      name: "note_update",
      arguments: { id: noteId, title: "MCP メモ (改)" },
    })) as CallResult;
    check(updRes.structuredContent?.updated === true, "note_update updated");

    // archive
    const arcRes = (await client.callTool({
      name: "note_archive",
      arguments: { id: noteId },
    })) as CallResult;
    check(arcRes.structuredContent?.archived === true, "note_archive で archived=true");

    // archive 済は通常 search に出ない
    const search2 = (await client.callTool({
      name: "note_search",
      arguments: { query: uniq },
    })) as CallResult;
    const s2 = (search2.structuredContent?.notes ?? []) as Array<{ id: number }>;
    check(!s2.some((n) => n.id === noteId), "archived は通常検索に出ない");

    // 入力検証: body_md 空は error
    const badRes = (await client.callTool({
      name: "note_create",
      arguments: { body_md: "" },
    })) as CallResult;
    check(badRes.isError === true, "空 body_md は zod で弾かれ isError");

    await client.close();
    await server.close();
  } finally {
    for (const id of created) {
      await deleteNote(id).catch(() => {});
    }
  }

  console.log(`\n=== ${passed} passed, ${failures.length} failed ===`);
  if (failures.length) {
    console.log("FAILED:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
  console.log("✅ all green");
  process.exit(0);
}

main().catch((e) => {
  console.error("[test-mcp] threw:", e);
  process.exit(1);
});
