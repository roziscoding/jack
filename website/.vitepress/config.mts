import { useSidebar } from 'vitepress-openapi'
import { withMermaid } from 'vitepress-plugin-mermaid'
import managementSpec from '../public/openapi/management.json' with { type: 'json' }
import peerSpec from '../public/openapi/peer.json' with { type: 'json' }

const siteUrl = 'https://jack.roz.ninja'
const socialImageUrl = `${siteUrl}/social-card.png`

// One collapsible group per tag, linking to the per-operation pages.
function apiSidebar(spec: any, linkPrefix: string) {
  return useSidebar({ spec, linkPrefix })
    .generateSidebarGroups({ linkPrefix })
    .map(group => ({ ...group, collapsed: true }))
}

export default withMermaid({
  title: 'jack',
  description: 'Share Radarr and Sonarr libraries directly with friends through a private, self-hosted peer-to-peer bridge.',
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: 'localhostLinks',
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/logo-light.svg' }],
    ['meta', { name: 'theme-color', content: '#6366f1' }],
  ],
  sitemap: {
    hostname: siteUrl,
  },

  transformPageData(pageData) {
    const title = pageData.params?.pageTitle
    const description = pageData.params?.pageDescription

    if (!title && !description)
      return

    return {
      title: title || pageData.title,
      description: description || pageData.description,
    }
  },

  transformHead({ page, pageData, title, description }) {
    if (pageData.isNotFound) {
      return [
        ['meta', { name: 'robots', content: 'noindex, nofollow' }],
      ]
    }

    const path = page
      .replace(/(^|\/)index\.md$/, '$1')
      .replace(/\.md$/, '')
    const url = new URL(path, `${siteUrl}/`).href
    const isHome = page === 'index.md'
    const structuredData = isHome
      ? {
          '@context': 'https://schema.org',
          '@type': 'SoftwareApplication',
          name: 'jack',
          description,
          url,
          applicationCategory: 'MultimediaApplication',
          operatingSystem: 'Docker',
          isAccessibleForFree: true,
          codeRepository: 'https://github.com/roziscoding/jack',
          license: 'https://www.gnu.org/licenses/gpl-3.0.html',
        }
      : {
          '@context': 'https://schema.org',
          '@type': 'TechArticle',
          headline: pageData.title,
          description,
          url,
          isPartOf: {
            '@type': 'WebSite',
            name: 'jack documentation',
            url: siteUrl,
          },
          ...(pageData.lastUpdated && {
            dateModified: new Date(pageData.lastUpdated).toISOString(),
          }),
        }

    return [
      ['link', { rel: 'canonical', href: url }],
      ['meta', { property: 'og:type', content: isHome ? 'website' : 'article' }],
      ['meta', { property: 'og:locale', content: 'en_US' }],
      ['meta', { property: 'og:site_name', content: 'jack' }],
      ['meta', { property: 'og:title', content: title }],
      ['meta', { property: 'og:description', content: description }],
      ['meta', { property: 'og:url', content: url }],
      ['meta', { property: 'og:image', content: socialImageUrl }],
      ['meta', { property: 'og:image:type', content: 'image/png' }],
      ['meta', { property: 'og:image:width', content: '1200' }],
      ['meta', { property: 'og:image:height', content: '630' }],
      ['meta', { property: 'og:image:alt', content: 'jack private media sharing for Radarr and Sonarr' }],
      ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
      ['meta', { name: 'twitter:title', content: title }],
      ['meta', { name: 'twitter:description', content: description }],
      ['meta', { name: 'twitter:image', content: socialImageUrl }],
      ['meta', { name: 'twitter:image:alt', content: 'jack private media sharing for Radarr and Sonarr' }],
      ['script', { type: 'application/ld+json' }, JSON.stringify(structuredData)],
    ]
  },

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
