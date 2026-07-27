import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import { theme, useTheme } from 'vitepress-openapi/client'
import 'vitepress-openapi/dist/style.css'
import './mermaid-zoom.css'

export default {
  extends: DefaultTheme,
  async enhanceApp({ app }) {
    useTheme({
      // Docs only — no "try it out" playground on operation pages.
      operation: {
        hiddenSlots: ['playground'],
      },
    })
    theme.enhanceApp({ app })

    if (typeof document !== 'undefined')
      setupMermaidZoom()
  },
} satisfies Theme

// Click a mermaid diagram to view it full-screen; click again or Esc to close.
function setupMermaidZoom() {
  const close = () => document.querySelector('.mermaid-zoom-overlay')?.remove()

  document.addEventListener('click', (event) => {
    const target = event.target as Element
    if (target.closest('.mermaid-zoom-overlay')) {
      close()
      return
    }
    const diagram = target.closest('.mermaid')
    const svg = diagram?.querySelector('svg')
    if (!svg)
      return
    const overlay = document.createElement('div')
    overlay.className = 'mermaid-zoom-overlay'
    overlay.appendChild(svg.cloneNode(true))
    document.body.appendChild(overlay)
  })

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape')
      close()
  })
}
