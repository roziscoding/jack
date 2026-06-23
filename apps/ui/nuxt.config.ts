import tailwindcss from '@tailwindcss/vite'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  devtools: { enabled: false },
  ssr: false,

  css: ['~/assets/css/main.css'],

  vite: {
    plugins: [tailwindcss()],
  },

  app: {
    head: {
      title: 'jack',
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
    },
  },

  // Server-only (the UI is a BFF: these must never reach the browser). The values
  // below are only defaults — Nitro overrides each at RUNTIME from the matching
  // `JACK_`-prefixed env var (JACK_MANAGEMENT_API_URL, JACK_MANAGEMENT_KEY,
  // JACK_SESSION_KEY). Runtime override matters because the image is built by CI;
  // the operator supplies these at container-run time, never at build time.
  runtimeConfig: {
    // Swap Nitro's default `NUXT_` runtime-env prefix for `JACK_`. `@nuxt/schema`
    // builds this as `{ envPrefix: 'NUXT_', ...runtimeConfig.nitro }`, so setting it
    // here (inside runtimeConfig.nitro) is what actually wins. (NITRO_ still works.)
    nitro: { envPrefix: 'JACK_' },
    // Where the jack management API listens (its own MANAGEMENT_PORT).
    managementApiUrl: 'http://localhost:5226',
    // When set, the BFF injects this as `X-Management-Key` and the browser is
    // never prompted (inject mode). When empty, the BFF prompts + stores the key
    // in a sealed cookie (cookie mode).
    managementKey: '',
    // Seals the cookie that holds the management key in cookie mode. MUST be set
    // (>= 32 chars) in production; the default is a clearly-insecure dev value.
    sessionKey: 'dev-insecure-session-key-change-me-please-1234',
  },
})
