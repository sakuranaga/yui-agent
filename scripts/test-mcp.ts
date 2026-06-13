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
import { registerTodoTools } from "@/lib/mcp/tools-todo";
import { registerReminderTools } from "@/lib/mcp/tools-reminder";
import { getMcpToken, rotateMcpToken, verifyMcpToken } from "@/lib/mcp-token";
import { deleteNote } from "@/lib/notes";
import { deleteTodo } from "@/lib/todos";
import { deleteReminder } from "@/lib/reminders";

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
  const createdTodos: string[] = [];
  const createdReminders: number[] = [];
  let call: (name: string, args: Record<string, unknown>) => Promise<CallResult> = async () => ({});
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
    registerTodoTools(server);
    registerReminderTools(server);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    await client.connect(clientT);
    call = (name, args) =>
      client.callTool({ name, arguments: args }) as Promise<CallResult>;

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    check(
      ["note_archive", "note_create", "note_get", "note_search", "note_update"].every((n) =>
        names.includes(n)
      ),
      `note tool 5 種が list される`
    );
    check(
      ["todo_add", "todo_list", "todo_search", "todo_update", "todo_complete"].every((n) =>
        names.includes(n)
      ),
      `todo tool 5 種が list される`
    );
    check(
      ["reminder_add", "reminder_list", "reminder_update", "reminder_disable"].every((n) =>
        names.includes(n)
      ),
      `reminder tool 4 種が list される`
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

    // --- 3. todo tools ---
    console.log("[3] MCP todo tools");
    const todoTitle = `MCP TODO ${Date.now()}`;
    const tAdd = await call("todo_add", { title: todoTitle, priority: 2 });
    const todoIdent = String(tAdd.structuredContent?.identifier ?? "");
    check(Number(tAdd.structuredContent?.id) > 0 && todoIdent !== "", "todo_add で id/identifier");
    if (todoIdent) createdTodos.push(todoIdent);
    const tSearch = await call("todo_search", { query: todoTitle });
    const tHits = (tSearch.structuredContent?.todos ?? []) as Array<{ identifier: string }>;
    check(tHits.some((t) => t.identifier === todoIdent), "todo_search でヒット");
    const tUpd = await call("todo_update", { identifier: todoIdent, priority: 1 });
    check(tUpd.structuredContent?.updated === true, "todo_update updated");
    const tDone = await call("todo_complete", { identifier: todoIdent });
    check(tDone.structuredContent?.completed === true, "todo_complete (= ソフト削除)");
    const tBad = await call("todo_add", { title: "" });
    check(tBad.isError === true, "空 title は zod で弾かれ isError");

    // --- 4. reminder tools ---
    console.log("[4] MCP reminder tools");
    const rAdd = await call("reminder_add", {
      title: `MCP リマインダー ${Date.now()}`,
      schedule_kind: "weekly",
      base_time: "08:00",
      weekdays: [1, 3, 5],
      lead_minutes: 0,
    });
    const remId = Number(rAdd.structuredContent?.id);
    check(remId > 0, `reminder_add で id (${remId})`);
    if (remId > 0) createdReminders.push(remId);
    const rList = await call("reminder_list", {});
    const rHits = (rList.structuredContent?.reminders ?? []) as Array<{ id: number; enabled: boolean }>;
    check(rHits.some((r) => r.id === remId), "reminder_list に出る (有効)");
    const rUpd = await call("reminder_update", { id: remId, title: "改名" });
    check(rUpd.structuredContent?.updated === true, "reminder_update updated");
    const rDis = await call("reminder_disable", { id: remId });
    check(rDis.structuredContent?.disabled === true, "reminder_disable (= ソフト削除)");
    const rList2 = await call("reminder_list", {});
    const rHits2 = (rList2.structuredContent?.reminders ?? []) as Array<{ id: number }>;
    check(!rHits2.some((r) => r.id === remId), "disable 後は既定一覧に出ない");
    const rBad = await call("reminder_add", { title: "x", schedule_kind: "once" });
    check(rBad.isError === true, "once で base_at 無しは error");
    const rBadTime = await call("reminder_add", {
      title: "x",
      schedule_kind: "weekly",
      base_time: "24:99",
    });
    check(rBadTime.isError === true, "範囲外 base_time (24:99) は error");

    await client.close();
    await server.close();
  } finally {
    for (const id of created) await deleteNote(id).catch(() => {});
    for (const ident of createdTodos) await deleteTodo(ident).catch(() => {});
    for (const id of createdReminders) await deleteReminder(id).catch(() => {});
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
