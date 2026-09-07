export default {
  extends: ["@commitlint/config-conventional"],
  defaultIgnores: false,
  rules: {
    "body-empty": [2, "always"],
    "footer-empty": [2, "always"],
    "scope-empty": [2, "always"],
  },
};
