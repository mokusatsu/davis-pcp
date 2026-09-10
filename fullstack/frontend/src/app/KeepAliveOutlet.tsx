import React, { useEffect, useMemo, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { useSelector } from 'react-redux'
import type { RootState } from './store'

import PcpPage from '../features/pcp/PcpPage'
import TablePage from '../features/table/TablePage'
import DistributionPage from '../features/distribution/DistributionPage'
import LikertComparisonPage from '../features/distribution/LikertComparisonPage'
import RelationshipsPage from '../features/relationships/RelationshipsPage'
import ClustersPage from '../features/clustering/ClustersPage'
import ModelsPage from '../features/models/ModelsPage'
import PcaPage from '../features/pca/PcaPage'
import TgtPage from '../features/tgt/TgtPage'
import LineMosaicPage from '../features/mosaic/LineMosaicPage'
import OverviewPage from '../features/dataset/OverviewPage'
import StatisticsPage from '../features/dataset/StatisticsPage'
import SubgroupMiningPage from '../features/mining/SubgroupMiningPage'
import SurpriseAssociationView from '../features/relationships/SurpriseAssociationView'
import RobustnessPage from '../features/robustness/RobustnessPage'
import KeyDriverAnalysisPage from '../features/models/kda/KeyDriverAnalysisPage'
import PenaltyRewardPage from '../features/pra/PenaltyRewardPage'
import FedfPage from '../features/fedf/FedfPage'
import BarChartPage from '../features/barchart/BarChartPage'
import LoessPlotPage from '../features/loess/LoessPlotPage'
import CovariancePage from '../features/covariance/CovariancePage'
import FeatureRankingPage from '../features/mining/FeatureRankingPage'
import LogisticRegressionPage from '../features/models/LogisticRegressionPage'
import DiscriminantAnalysisPage from '../features/models/DiscriminantAnalysisPage'
import CrosstabPage from '../features/crosstab/CrosstabPage'

/**
 * Route path to Component registry.
 */
const ROUTE_COMPONENTS: Record<string, React.ComponentType> = {
  '/pcp': PcpPage,
  '/table': TablePage,
  '/distribution': DistributionPage,
  '/likert': LikertComparisonPage,
  '/relationships': RelationshipsPage,
  '/clusters': ClustersPage,
  '/models': ModelsPage,
  '/pca': PcaPage,
  '/touring': TgtPage,
  '/mosaic': LineMosaicPage,
  '/overview': OverviewPage,
  '/statistics': StatisticsPage,
  '/ranking': FeatureRankingPage,
  '/subgroups': SubgroupMiningPage,
  '/associations': SurpriseAssociationView,
  '/robustness': RobustnessPage,
  '/key-drivers': KeyDriverAnalysisPage,
  '/penalty-reward': PenaltyRewardPage,
  '/fedf': FedfPage,
  '/barchart': BarChartPage,
  '/loess': LoessPlotPage,
  '/covariance': CovariancePage,
  '/logistic': LogisticRegressionPage,
  '/discriminant': DiscriminantAnalysisPage,
  '/crosstab': CrosstabPage,
}

/**
 * KeepAliveOutlet:
 * Replaces standard React Router <Outlet />.
 *
 * Keeps visited route components mounted in memory/DOM with `display: none`
 * so that running analyses (Clusters, Models, Logistic, etc.), slider inputs,
 * and UI view configurations are never lost when navigating between tabs.
 *
 * When the datasetId changes, all cached tab states are safely flushed and
 * re-initialized cleanly for the new dataset.
 */
export default function KeepAliveOutlet() {
  const location = useLocation()
  const datasetId = useSelector((s: RootState) => s.selection.datasetId)

  // Normalize root path '/' to '/pcp'
  const normalizedPath = useMemo(() => {
    const p = location.pathname.replace(/\/$/, '')
    return p === '' ? '/pcp' : p
  }, [location.pathname])

  const [visitedPaths, setVisitedPaths] = useState<Set<string>>(() => new Set([normalizedPath]))

  // Track visited routes
  useEffect(() => {
    setVisitedPaths((prev) => {
      if (prev.has(normalizedPath)) return prev
      const next = new Set(prev)
      next.add(normalizedPath)
      return next
    })
  }, [normalizedPath])

  const isKnownRoute = Boolean(ROUTE_COMPONENTS[normalizedPath])

  return (
    <div
      key={datasetId ?? 'no-dataset'}
      data-testid="keep-alive-outlet-container"
      style={{
        width: '100%',
        height: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        position: 'relative',
      }}
    >
      {Array.from(visitedPaths).map((path) => {
        const Component = ROUTE_COMPONENTS[path]
        if (!Component) return null
        const isActive = path === normalizedPath
        return (
          <div
            key={path}
            data-tab-path={path}
            data-tab-active={isActive ? 'true' : 'false'}
            style={{
              display: isActive ? 'flex' : 'none',
              flexDirection: 'column',
              width: '100%',
              height: '100%',
              minHeight: 0,
              flex: 1,
            }}
          >
            <Component />
          </div>
        )
      })}
      {/* Fallback for any dynamic or unregistered subroutes */}
      {!isKnownRoute && <Outlet />}
    </div>
  )
}
