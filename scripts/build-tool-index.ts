/**
 * tool_index を build / reindex する CLI。
 *   docker compose exec web npx tsx scripts/build-tool-index.ts
 *
 * ALL_TOOLS の description + TOOL_EXAMPLES の例文を embed して tool_index に投入し、
 * active_tool_index_version を切り替える (旧 version は掃除)。embed モデル変更後や
 * 例文コーパス更新後に再実行する。設計: docs/tool-dispatch-redesign.md §12.2/§12.4。
 */
import { buildToolIndex } from "@/lib/tools/tool-index";

(async () => {
  const t0 = Date.now();
  const { version, rows } = await buildToolIndex();
  console.log(`✅ tool_index built: version=${version} rows=${rows} (${Date.now() - t0}ms)`);
  process.exit(0);
})().catch((e) => {
  console.error("❌ tool_index build failed:", e);
  process.exit(1);
});
