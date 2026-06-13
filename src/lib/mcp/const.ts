/**
 * MCP サーバ共通定数。
 *
 * MCP は web セッションに紐づかないので、session-scoped な lib 書き込み
 * (todos / reminders の **作成**) には正規 owner session 定数を attribution として使う。
 * notes はグローバルなので sessionId 不要。
 *
 * 注意: これは「作成時の所属」だけで、**所有権境界ではない**。MCP の list/update/
 * complete/disable は id/identifier 指定で **全 todo/reminder を対象に操作できる**
 * (= ご主人様自身のエージェントが、ゆい/UI で作った分も含めて管理できる設計。意図的)。
 */
export const MCP_OWNER_SESSION_ID = "primary";
