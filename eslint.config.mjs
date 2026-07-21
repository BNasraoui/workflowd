import eslint from "@eslint/js"
import globals from "globals"
import tseslint from "typescript-eslint"
import architecturePlugin from "./eslint-rules/architecture/index.mjs"
import effectPlugin from "./eslint-rules/effect/index.mjs"

const typeScriptFiles = ["**/*.ts"]
const localPluginTypeScriptFiles = ["eslint-rules/**/*.{mts,cts}"]
const localPluginTypeScript = tseslint.configs.recommended.map((config) => ({
  ...config,
  files: localPluginTypeScriptFiles,
}))
const typeChecked = tseslint.configs.recommendedTypeChecked.map((config) => ({
  ...config,
  files: typeScriptFiles,
}))

export default tseslint.config(
  eslint.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },
  ...localPluginTypeScript,
  ...typeChecked,
  {
    files: ["**/*.ts"],
    plugins: {
      architecture: architecturePlugin,
    },
    languageOptions: {
      globals: globals.bunBuiltin,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "architecture/no-double-assertion-through-unknown": "error",
      "@typescript-eslint/no-unsafe-type-assertion": "error",
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
  {
    files: ["src/**/*.ts"],
    plugins: {
      effect: effectPlugin,
    },
    rules: {
      "architecture/no-unknown-effect-channels": "error",
      "effect/no-direct-throw-in-gen": "error",
      "effect/no-sync-schema-decode-in-gen": "error",
      "effect/no-throwing-operation-in-sync": "error",
      "effect/require-promise-rejection-handler": "error",
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      "architecture/no-test-contract-replacements": "error",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },
)
