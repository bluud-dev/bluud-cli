/** @type {import("prettier").Config} */
export default {
  semi: true,
  trailingComma: "all",
  singleQuote: false,
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  // Pinned explicitly (matches this project's own default) rather than left
  // implicit, so the expectation survives a future Prettier major bump.
  // .gitattributes enforces the same policy at checkout so the two can never
  // disagree — see its header comment for the full story.
  endOfLine: "lf",
};
