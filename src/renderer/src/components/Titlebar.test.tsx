import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Titlebar } from './Titlebar'

describe('cockpit navigation', () => {
  it('offers the cockpit even without captured sessions and marks the selected view', () => {
    const noop = vi.fn()
    const html = renderToStaticMarkup(
      <Titlebar view="cockpit" drag={{ active: false, over: false }} workspace={null} hasSessions={false}
        lang="de" onLang={noop} onView={noop} onPicker={noop} onWorkspaces={noop} onAgent={noop} />
    )
    expect(html).toContain('Cockpit')
    expect(html).toContain('aria-pressed="true"')
  })
})
