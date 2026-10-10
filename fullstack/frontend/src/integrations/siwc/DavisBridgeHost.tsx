// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect } from 'react'
import { createDavisOptions, createDavisRevisionMonitor, type DavisRouterPort, type DavisStore } from './davisAdapter'
import { createCorrespondenceWorkflow } from './correspondenceWorkflow'
import { registerPageBridge } from './sdk/page-bridge.js'

/** One document owner, mounted only after the ordinary app/runtime is ready. */
export function installDavisBridge(store: DavisStore, router: DavisRouterPort): () => void {
  const monitor = createDavisRevisionMonitor({ store, router })
  const workflow = createCorrespondenceWorkflow({ store, router, monitor })
  let unregister: (() => void) | undefined
  try {
    unregister = registerPageBridge(createDavisOptions({ store, router, monitor, workflow }))
  } catch (error) {
    workflow.dispose(); monitor.dispose(); throw error
  }
  return () => { unregister?.(); unregister = undefined; workflow.dispose(); monitor.dispose() }
}

export default function DavisBridgeHost({ store, router, enabled }: { store: DavisStore; router: DavisRouterPort; enabled: boolean }) {
  useEffect(() => {
    // The supplied protocol is HTTPS/top-level only. Local HTTP keeps its ordinary UI.
    if (!enabled || window !== window.top || location.protocol !== 'https:') return
    let cleanup: (() => void) | null = null
    const stop = () => { cleanup?.(); cleanup = null }
    const start = () => { if (!cleanup) cleanup = installDavisBridge(store, router) }
    start()
    window.addEventListener('pagehide', stop)
    window.addEventListener('pageshow', start)
    return () => {
      window.removeEventListener('pagehide', stop)
      window.removeEventListener('pageshow', start)
      stop()
    }
  }, [enabled, store, router])
  return null
}
