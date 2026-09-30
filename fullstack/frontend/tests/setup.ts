import { setPlatformAPI } from 'echarts'
// jsdom has no canvas text metrics; SVG rendering remains real ECharts.
setPlatformAPI({ measureText: text => ({ width: String(text).length * 7 }) })
import '@testing-library/jest-dom/vitest'

if (typeof window !== 'undefined') Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
})
