import antfu from '@antfu/eslint-config'

export default antfu({
  typescript: true,
  rules: {
    'ts/no-redeclare': 'off',
    'antfu/no-top-level-await': 'off',
    // 'jsonc/comma-dangle': ['warn', 'always-multiline'],
  },
})
