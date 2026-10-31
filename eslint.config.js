/**
 * ESLint configuration for Airi OS (mc-ai-bot)
 * Using flat config format (ESLint 9+)
 */

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';

// Dynamic import for @typescript-eslint/parser (ESM compatibility)
const tsParser = await import('@typescript-eslint/parser');

export default tseslint.config(
  // Base configs
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.stylistic,
  ...pluginVue.configs['flat/recommended'],

  // Global ignores
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'backup_*/**',
      '*.log',
      'bot_logs.txt',
      '.env*',
      'chat.json',
      'memory.json',
      'users.json',
      'coverage/**',
      '.nyc_output/**',
      // Config files (JSON)
      '**/tsconfig*.json',
      // Legacy JavaScript files (not TypeScript)
      'bot.js',
      'backup_bot.js',
      'memory.js',
      'index.html',
      // Desktop legacy JavaScript files
      'desktop/bot-child.js',
      'desktop/main.js',
      'desktop/preload.js',
      'desktop/renderer.js',
      // Website test folder
      'Website test/**',
      // Build folder
      'build/**',
      // Desktop bot-worker (separate project)
      'desktop/bot-worker/**',
    ],
  },

  // TypeScript configs for main project
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TypeScript recommended rules
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/await-thenable': 'error',
    },
  },

  // Desktop main process
  {
    files: ['desktop/**/*.ts', 'desktop/**/*.tsx'],
    languageOptions: {
      parserOptions: {
        project: './desktop/tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        process: 'readonly',
        require: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },

  // Renderer (Vue) config - TypeScript files
  {
    files: ['desktop/renderer/**/*.ts', 'desktop/renderer/**/*.tsx'],
    languageOptions: {
      parserOptions: {
        project: './desktop/renderer/tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },

  // Renderer (Vue) config - Vue files
  {
    files: ['desktop/renderer/**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tsParser.default,
        project: './desktop/renderer/tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.vue'],
      },
    },
    rules: {
      'vue/multi-word-component-names': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },

  // Config files (allow any for config flexibility) - must come after project-specific configs to override
  {
    files: ['*.config.*', '*.config.ts', '*.config.js', 'vite.config.ts', 'vitest.config.ts'],
    languageOptions: {
      parserOptions: {
        project: null,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },

  // Renderer config files (vite.config.ts, tsconfig.node.json) - disable project to avoid reference issues
  {
    files: ['desktop/renderer/vite.config.ts', 'desktop/renderer/tsconfig.node.json'],
    languageOptions: {
      parserOptions: {
        project: null,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },

  // Test files
  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        vi: 'readonly',
        jest: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  }
);
