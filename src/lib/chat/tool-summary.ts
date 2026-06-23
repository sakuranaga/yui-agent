/**
 * 任意 tool の input を 1 行 (~80 文字) のサマリに圧縮。
 * raw_messages.tool_summary に積み、次ターン送信時に「過去ターン実行済み」シグナルとして渡す。
 */
export function briefToolInput(toolName: string, input: Record<string, unknown>): string {
  const v = (k: string): string | undefined => {
    const x = input[k];
    return typeof x === "string" && x.length > 0 ? x : undefined;
  };

  switch (toolName) {
    case "add_todo": {
      const parts: string[] = [];
      if (v("title")) parts.push(`title="${v("title")}"`);
      if (v("project")) parts.push(`project=${v("project")}`);
      if (v("state")) parts.push(`state=${v("state")}`);
      return parts.join(" ");
    }
    case "update_todo":
    case "complete_todo":
    case "delete_todo":
    case "get_todo": {
      return v("identifier") ? `identifier=${v("identifier")}` : "";
    }
    case "list_todos":
    case "search_todos": {
      const q = v("query") ?? v("project") ?? v("tag");
      return q ? `q=${q.slice(0, 60)}` : "";
    }
    case "web_search":
    case "web_fetch": {
      const q = v("query") ?? v("url");
      return q ? `q=${q.slice(0, 60)}` : "";
    }
    case "create_timer": {
      return [v("label"), v("fire_at"), v("relative")].filter(Boolean).join(" ");
    }
    case "add_reminder": {
      const parts: string[] = [];
      if (v("title")) parts.push(`title="${v("title")}"`);
      if (v("base_at")) parts.push(`base_at=${v("base_at")}`);
      if (v("base_time")) parts.push(`base_time=${v("base_time")}`);
      return parts.join(" ");
    }
    case "cancel_timer": {
      return v("id") ?? v("match") ?? "";
    }
    default: {
      const q = v("query");
      if (q) return `query=${q.slice(0, 60)}`;
      for (const [k, val] of Object.entries(input)) {
        if (typeof val === "string" && val.length > 0) {
          return `${k}=${val.slice(0, 60)}`;
        }
      }
      return "";
    }
  }
}
