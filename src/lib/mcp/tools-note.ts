/**
 * ゆい MCP サーバ: ノート tool (docs/yui-mcp-server.md §5.1)。
 * 既存 lib (src/lib/notes.ts) を直接呼ぶ。物理削除 (deleteNote) は公開せず、archive (ソフト削除) のみ。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createNote, queryNotes, getNote, updateNote } from "@/lib/notes";

/** tool 成功レスポンス (structuredContent + text を両方返す)。 */
function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data as Record<string, unknown>,
  };
}

/**
 * tool 失敗レスポンス。CLAUDE.md 準拠で client には固定文のみ、詳細は server log。
 */
function fail(context: string, e: unknown, message: string) {
  console.error(`[mcp:${context}]`, e instanceof Error ? e.message : e);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

export function registerNoteTools(server: McpServer): void {
  server.registerTool(
    "note_create",
    {
      title: "ノート作成",
      description:
        "ゆいのノート空間に markdown ノートを保存する。title は省略可 (本文先頭から自動生成)。",
      inputSchema: {
        body_md: z.string().trim().min(1).describe("ノート本文 (markdown)"),
        title: z.string().optional().describe("タイトル (省略時は本文先頭から自動生成)"),
      },
    },
    async ({ body_md, title }) => {
      try {
        const note = await createNote({
          title: title?.trim() || undefined,
          bodyMd: body_md,
          source: "mcp",
        });
        return ok({ id: note.id, title: note.title });
      } catch (e) {
        return fail("note_create", e, "ノートの作成に失敗しました");
      }
    }
  );

  server.registerTool(
    "note_search",
    {
      title: "ノート検索",
      description:
        "ノートを検索/一覧する。query 省略時は新しい順の一覧 (browse)、指定時は意味+全文検索 (search)。",
      inputSchema: {
        query: z.string().optional().describe("検索語 (省略で一覧)"),
        limit: z.number().int().positive().max(200).optional().describe("最大件数 (既定 100)"),
        include_archived: z.boolean().optional().describe("アーカイブ済も含めるか"),
      },
    },
    async ({ query, limit, include_archived }) => {
      try {
        const res = await queryNotes({
          query,
          limit,
          includeArchived: include_archived,
        });
        return ok({
          mode: res.mode,
          total: res.total,
          notes: res.notes.map((n) => ({
            id: n.id,
            title: n.title,
            preview: n.preview,
            source: n.source,
            pinned: n.pinned,
            archived: n.archived,
            updated_at: n.updatedAt,
          })),
        });
      } catch (e) {
        return fail("note_search", e, "ノートの検索に失敗しました");
      }
    }
  );

  server.registerTool(
    "note_get",
    {
      title: "ノート取得",
      description: "id を指定してノート本文 (markdown) を取得する。",
      inputSchema: { id: z.number().int().positive().describe("ノート id") },
    },
    async ({ id }) => {
      try {
        const note = await getNote(id);
        if (!note) return ok({ found: false, id });
        return ok({ found: true, id: note.id, title: note.title, body_md: note.bodyMd });
      } catch (e) {
        return fail("note_get", e, "ノートの取得に失敗しました");
      }
    }
  );

  server.registerTool(
    "note_update",
    {
      title: "ノート更新",
      description: "ノートの title / 本文を更新する。本文更新時は内部で再埋め込みされる。",
      inputSchema: {
        id: z.number().int().positive().describe("ノート id"),
        title: z.string().optional().describe("新しいタイトル"),
        body_md: z.string().optional().describe("新しい本文 (markdown)"),
      },
    },
    async ({ id, title, body_md }) => {
      try {
        const note = await updateNote(id, {
          title: title,
          bodyMd: body_md,
        });
        if (!note) return ok({ updated: false, id });
        return ok({ updated: true, id: note.id, title: note.title });
      } catch (e) {
        return fail("note_update", e, "ノートの更新に失敗しました");
      }
    }
  );

  server.registerTool(
    "note_archive",
    {
      title: "ノートのアーカイブ",
      description:
        "ノートをアーカイブ (ソフト削除) する。archived=false で復元。物理削除は MCP からはできない。",
      inputSchema: {
        id: z.number().int().positive().describe("ノート id"),
        archived: z.boolean().optional().describe("true=アーカイブ (既定) / false=復元"),
      },
    },
    async ({ id, archived }) => {
      try {
        const note = await updateNote(id, { archived: archived ?? true });
        if (!note) return ok({ updated: false, id });
        return ok({ updated: true, id: note.id, archived: note.archived });
      } catch (e) {
        return fail("note_archive", e, "ノートのアーカイブに失敗しました");
      }
    }
  );
}
