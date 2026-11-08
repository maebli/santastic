import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "dist/**", ".wrangler/**"] },
  js.configs.recommended,
  { files: ["public/**/*.js"], languageOptions: { globals: globals.browser } },
  {
    files: ["server/**/*.js", "tests/**/*.js", "scripts/**/*.js"],
    languageOptions: { globals: globals.node },
  },
];
