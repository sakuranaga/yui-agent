// ESLint flat config for Next.js 16+。
// eslint-config-next 16 は **flat config ネイティブ** に移行したので、
// 旧 FlatCompat 経由ではなく直接 import する (= FlatCompat だと 16 系の
// flat config を旧 eslintrc validator にかけて circular ref エラーになる)。
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const config = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  // React 19 + Next 16 で eslint-plugin-react-hooks v6 が追加した新ルール群は
  // 既存コードに 90+ 件 hit する (= 段階的 refactor 対象)。runtime バグでは
  // ないので一旦 warn に下げ、follow-up issue で順次 fix する方針。
  // 参考: https://react.dev/reference/rules
  {
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/refs": "warn",
      // `_xxx` プレフィックス = 意図的に未使用 (TypeScript 流儀)。
      // 公式パターン: https://typescript-eslint.io/rules/no-unused-vars
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          args: "all",
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "apps/discord-bot/**", // 別 process
      "drizzle/**",
      "data/**",
      "logs/**",
      "config/**",
      "scripts/**",
      "src/scripts/**",
      "src/db/migrate.ts",
      "next-env.d.ts", // Next.js 自動生成
    ],
  },
  // ───── SSRF 防護: server-side で raw fetch を禁止 ─────
  // 外部 URL を叩く時は src/lib/safe-fetch.ts の safeFetch() を使う (= private/loopback
  // /metadata 範囲拒否 + 手動 redirect 検証 + size/timeout 上限)。
  // 内部 self-call (= http://localhost:3000/api/...) は src/lib/internal-fetch.ts の
  // internalFetch() を使う (= 認証ヘッダ auto-attach)。
  // 公式 SDK と同等に「固定 hostname の外部公式 API を直接叩く」場合のみ、
  // 該当行に `// eslint-disable-next-line no-restricted-syntax -- <理由>` を付ける。
  {
    files: [
      "src/lib/**/*.ts",
      "src/lib/**/*.tsx",
      "src/app/api/**/*.ts",
      "src/app/api/**/*.tsx",
      "src/periodic/**/*.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.type='Identifier'][callee.name='fetch']",
          message:
            "raw fetch() 禁止: 外部 URL は safeFetch (src/lib/safe-fetch.ts)、内部 self-call は internalFetch (src/lib/internal-fetch.ts) を使う。公式 SDK と同等の固定 hostname 外部 API を直接叩く場合のみ // eslint-disable-next-line no-restricted-syntax -- <理由> で例外化。",
        },
      ],
    },
  },
  // safe-fetch.ts と internal-fetch.ts は自身で fetch を呼ぶので例外
  {
    files: ["src/lib/safe-fetch.ts", "src/lib/internal-fetch.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
];

export default config;
