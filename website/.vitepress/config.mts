import { useSidebar } from 'vitepress-openapi'
import { withMermaid } from 'vitepress-plugin-mermaid'
import managementSpec from '../public/openapi/management.json' with { type: 'json' }
import peerSpec from '../public/openapi/peer.json' with { type: 'json' }

// One collapsible group per tag, linking to the per-operation pages.
function apiSidebar(spec: any, linkPrefix: string) {
  return useSidebar({ spec, linkPrefix })
    .generateSidebarGroups({ linkPrefix })
    .map(group => ({ ...group, collapsed: true }))
}

export default withMermaid({
  // Set by the publish workflow (e.g. /jack/ for GitHub Pages); local dev serves from /.
  base: process.env.DOCS_BASE || '/',
  title: 'jack',
  description: 'Share media libraries with friends through the *arr stack you already run',
  lang: 'en-US',
  lastUpdated: true,
  ignoreDeadLinks: 'localhostLinks',

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/what-is-jack', activeMatch: '/guide/' },
      { text: 'Reference', link: '/reference/configuration', activeMatch: '/reference/' },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'What is jack?', link: '/guide/what-is-jack' },
            { text: 'Getting started', link: '/guide/getting-started' },
            { text: 'Sample files', link: '/guide/sample-files' },
            { text: 'How it works', link: '/guide/how-it-works' },
          ],
        },
        {
          text: 'Operating jack',
          items: [
            { text: 'Management UI', link: '/guide/management-ui' },
            { text: 'API keys & peering', link: '/guide/peering' },
            { text: 'Running without Docker', link: '/guide/running-without-docker' },
            { text: 'Troubleshooting', link: '/guide/troubleshooting' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Configuration', link: '/reference/configuration' },
            { text: 'Environment variables', link: '/reference/environment-variables' },
          ],
        },
        {
          text: 'Peer API',
          items: [
            { text: 'Overview', link: '/reference/peer-api' },
            ...apiSidebar(peerSpec, '/reference/peer-api/'),
          ],
        },
        {
          text: 'Management API',
          items: [
            { text: 'Overview', link: '/reference/management-api' },
            ...apiSidebar(managementSpec, '/reference/management-api/'),
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/roziscoding/jack' },
    ],

    search: {
      provider: 'local',
    },

    footer: {
      message: 'Released under the GPL-3.0 License.',
    },

    editLink: {
      pattern: 'https://github.com/roziscoding/jack/edit/main/website/:path',
      text: 'Edit this page on GitHub',
    },
  },
})
