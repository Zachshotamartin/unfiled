import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/.next/**", "**/coverage/**", "**/node_modules/**"]
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-magic-numbers": "off",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }]
    }
  },
  {
    // A hook reached only on some renders takes the whole page down, not the component: a
    // useEffect placed after an early return rendered every screen as "This page did not load"
    // while every request behind it answered 200. No test shape catches it, because it needs a
    // second render to appear, so the rule has to.
    files: ["**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error"
    }
  },
  {
    files: [
      "**/*.config.js",
      "**/*.config.mjs",
      "**/*.config.ts",
      "scripts/**/*.ts",
      "apps/*/api/**/*.js"
    ],
    extends: [tseslint.configs.disableTypeChecked]
  }
);
