/**
 * Prettier configuration for Airi OS (mc-ai-bot)
 */

export default {
  // General
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: true,
  quoteProps: 'as-needed',
  jsxSingleQuote: true,
  trailingComma: 'es5',
  bracketSpacing: true,
  bracketSameLine: false,
  arrowParens: 'always',
  rangeStart: 0,
  rangeEnd: Infinity,
  requirePragma: false,
  insertPragma: false,
  proseWrap: 'always',
  htmlWhitespaceSensitivity: 'css',
  endOfLine: 'lf',
  embeddedLanguageFormatting: 'auto',

  // Language specific
  plugins: [],

  // Overrides for specific file types
  overrides: [
    {
      files: ['*.json', '*.jsonc'],
      options: {
        printWidth: 120,
        tabWidth: 2,
      },
    },
    {
      files: ['*.md', '*.markdown'],
      options: {
        printWidth: 100,
        proseWrap: 'always',
      },
    },
    {
      files: ['*.yaml', '*.yml'],
      options: {
        tabWidth: 2,
        singleQuote: false,
      },
    },
    {
      files: ['*.html', '*.vue'],
      options: {
        parser: 'vue',
        printWidth: 120,
      },
    },
    ],
};