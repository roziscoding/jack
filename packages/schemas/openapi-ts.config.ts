import { defineConfig } from '@hey-api/openapi-ts'

export default defineConfig({
  input: './jellyfin.openapi.json', // sign up at app.heyapi.dev
  output: {
    path: './src/generated/jellyfin',
    entryFile: false,
  },
  plugins: [
    {
      name: 'zod',
      compatibilityVersion: 4
    },
    {
      name: '@hey-api/sdk',
      auth: true,
      operations: {
        strategy: 'single',
        nesting: 'operationId',
      },
      paramsStructure: 'flat',
      responseStyle: 'fields',
    },
  ],
})
