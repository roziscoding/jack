---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts,*.tsx, *.html,*.css, *.js,*.jsx, package.json"
alwaysApply: false
---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { expect, test } from 'bun:test'

test('hello world', () => {
  expect(1).toBe(1)
})
```

## Git

- Use Conventional Commits for commit messages, e.g. `feat: add peer search spans` or `fix: handle missing torrent files`.
- `ai_docs/` is gitignored. Don't worry about git state for changes under `ai_docs/`, and don't try to commit them.

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from './index.html'

Bun.serve({
  routes: {
    '/': index,
    '/api/users/:id': {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }))
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send('Hello, world!')
    },
    message: (ws, message) => {
      ws.send(message)
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from 'react'
import { createRoot } from 'react-dom/client'

// import .css files directly and it works
import './index.css'

const root = createRoot(document.body)

export default function Frontend() {
  return <h1>Hello, world!</h1>
}

root.render(<Frontend />)
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## Writing

Applies to the docs site under `website/`, PR descriptions, and commit bodies.

### Structure

- Lead with the answer, the definition, or the change. No preamble, no restating the question, no announcing the shape of what follows.
- Stop when the point is made. No tie-backs, no per-section recaps, no closing summary.
- Don't count items before listing them ("three things", "for two reasons") unless the count is the point ("both calls fail", "all four migrations ran").
- Cut what's obvious from context. "The link stops working" needs no "for whoever holds it".
- Make each point once, in the place it belongs. A clarification that dangles at the end of a block is misplaced, not merely wordy: move it onto the item it qualifies, or promote it to a callout.
- Don't defend a point nobody contested.
- Documentation is not a changelog. Describe the current behaviour.

### Constructions to avoid

- Plainest word that carries the meaning. Ornate vocabulary is a problem when it inflates something ordinary, not on sight: "JS ecosystem" is the right word, "a robust ecosystem of tooling" where "several tools" is meant is not. Same for analogies and figurative language, which are worth it only when they explain something a plain description can't.
- Adverbs used to lend weight (quietly, deeply, fundamentally, remarkably, arguably) rather than to say something true about degree.
- Negative parallelism: "it's not X, it's Y", "not just X but Y", "the question isn't A, it's B".
- Em dashes as dramatic pauses or pivots. A comma, a colon, or a second sentence usually reads better.
- The prose/list hybrid: a sentence that trails into an enumeration ("rejected whole: bad prefix, corrupt payload, a non-HTTP URL, or a bad header"). Write a real list or write prose.
- Cute vagueness standing in for the fact. "The endpoint does what the button does" says nothing; say what it does.
- Quotable one-liners that carry no information ("a quick link is only as live as the key inside it").
- Fragment paragraphs for emphasis, and repeated sentence openings.
- Rule-of-three phrasing. Not one per page, not one per section: zero. It's the loudest AI tell in the text.
- Invented compound labels (`the supervision paradox`, `credential creep`) presented as established terms.
- Filler and teaching voice: "it's worth noting", "importantly", "let's unpack", "think of it as".
- "serves as" / "represents" where "is" works. "Despite these challenges, ..." dismissals. Vague attributions to experts or reports.
- Wh-word headings ("What's inside a link" -> "Link format"). Title case headings.

### Markdown conventions

- **Bold leads on definition bullets** are good, keep them. A bulleted field list beats a table unless the content is genuinely tabular and each cell is short.
- UI references (breadcrumbs, buttons, form and section names) get bold+italic: `***Settings -> Downloads***`, `***Add peer***`. Plain italic stays free for emphasis.
- One idea per list item. Split compound items rather than joining them with "and".
- When an item has its own rules, nest a sub-list instead of packing them into the sentence.
- Callout titles state the fact plainly: "Internal and external URLs are not the same", not something clever.
- Link an identifier to its canonical reference page whenever the docs generate one. Management API routes have a per-operation page at `/reference/management-api/<operationId>`; linking the overview instead makes the reader hunt.
- ASCII punctuation in prose: `->`, straight quotes, `...`. Mermaid blocks are the exception and keep `→`, since `->` collides with mermaid's own arrow syntax.
- Wrap prose at 80 columns, and keep `jack` lowercase in running text.
