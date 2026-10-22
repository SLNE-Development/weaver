import config from "@weaver/config/eslint";
export default [
  ...config,
  { ignores: ["next-env.d.ts"] },
  // Plain Node.js scripts (seed-e2e.ts) run outside Next.js.
  { files: ["scripts/**/*.ts"], languageOptions: { globals: { process: "readonly", console: "readonly" } } },
];
