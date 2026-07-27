import antfu from '@antfu/eslint-config'
import markdownLinks from 'eslint-plugin-markdown-links'

export default antfu(
  {
    typescript: true,
    // Vue lives only in apps/ui's package.json, so antfu's auto-detect misses it
    // from the repo root — enable it explicitly so .vue files are linted.
    vue: true,
    rules: {
      'ts/no-redeclare': 'off',
      'antfu/no-top-level-await': 'off',
      // 'jsonc/comma-dangle': ['warn', 'always-multiline'],
    },
  },
  {
    ignores: ['packages/schemas/src/generated/**'],
  },
  {
    // Docs prose is full of literal `*arr`, which the emphasis rule mangles when
    // autofixing. Fragment checking is swapped for markdown-links', which knows
    // VitePress's mdit-vue slugger (the official rule only speaks GitHub slugs).
    files: ['website/**/*.md'],
    plugins: {
      'markdown-links': markdownLinks,
    },
    rules: {
      'markdown/no-space-in-emphasis': 'off',
      'markdown/no-missing-link-fragments': 'off',
      'markdown-links/no-missing-fragments': ['error', { slugify: 'mdit-vue' }],
    },
  },
  {
    // Force all span attributes through the redacting/serializing funnel in
    // lib/span-attributes.ts. The helper itself is the only sanctioned caller.
    files: ['apps/backend/**/*.ts'],
    ignores: ['apps/backend/src/lib/span-attributes.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.property.name=/^setAttributes?$/]',
          message: 'Do not call span.setAttribute(s) directly. Use setSpanAttribute(s) from lib/span-attributes.ts so values are redacted, serialized, and truncated.',
        },
      ],
    },
  },
)
