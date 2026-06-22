import antfu from '@antfu/eslint-config'

export default antfu(
  {
    typescript: true,
    rules: {
      'ts/no-redeclare': 'off',
      'antfu/no-top-level-await': 'off',
      // 'jsonc/comma-dangle': ['warn', 'always-multiline'],
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
