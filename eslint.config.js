import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      "no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrors: "none",
      }],
    },
  },
  {
    files: ["test/browser/**/*.js"],
    languageOptions: {
      globals: {
        SHARC: "readonly",
        mraid: "readonly",
      },
    },
  },
  {
    files: ["test/**/*.js", "tools/creative-validator/**/*.js"],
    rules: {
      // Test fixtures intentionally assert parser handling of control ranges
      // and fixed whitespace; production sources keep the recommended rules.
      "no-control-regex": "off",
      "no-regex-spaces": "off",
    },
  },
];
