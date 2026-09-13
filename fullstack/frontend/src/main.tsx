import React, { useState, useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { Provider } from 'react-redux'
import { createBrowserRouter, createHashRouter, RouterProvider } from 'react-router-dom'
import { ConfigProvider, theme as antdTheme } from 'antd'
import jaJP from 'antd/locale/ja_JP'
import AppShell from './app/AppShell'
import PcpPage from './features/pcp/PcpPage'
import TablePage from './features/table/TablePage'
import DistributionPage from './features/distribution/DistributionPage'
import LikertComparisonPage from './features/distribution/LikertComparisonPage'
import RelationshipsPage from './features/relationships/RelationshipsPage'
import ClustersPage from './features/clustering/ClustersPage'
import ModelsPage from './features/models/ModelsPage'
import PcaPage from './features/pca/PcaPage'
import TgtPage from './features/tgt/TgtPage'
import LineMosaicPage from './features/mosaic/LineMosaicPage'
import OverviewPage from './features/dataset/OverviewPage'
import StatisticsPage from './features/dataset/StatisticsPage'
import SubgroupMiningPage from './features/mining/SubgroupMiningPage'
import SurpriseAssociationView from './features/relationships/SurpriseAssociationView'
import RobustnessPage from './features/robustness/RobustnessPage'
import KeyDriverAnalysisPage from './features/models/kda/KeyDriverAnalysisPage'
import PenaltyRewardPage from './features/pra/PenaltyRewardPage'
import FedfPage from './features/fedf/FedfPage'
import BarChartPage from './features/barchart/BarChartPage'
import LoessPlotPage from './features/loess/LoessPlotPage'
import CovariancePage from './features/covariance/CovariancePage'
import FeatureRankingPage from './features/mining/FeatureRankingPage'
import CrosstabPage from './features/crosstab/CrosstabPage'
import LogisticRegressionPage from './features/models/LogisticRegressionPage'
import DiscriminantAnalysisPage from './features/models/DiscriminantAnalysisPage'
import CorrespondenceAnalysisPage from './features/models/CorrespondenceAnalysisPage'
import { store } from './app/store'
import { FocusModeProvider } from './features/common/FocusMode'
import { IS_STATIC_BUILD } from './api/client'
import { WasmLoadingScreen } from './app/WasmLoadingScreen'
import { pyodideClient } from './engine/pyodideClient'
import './theme/viz.css'

const routeChildren = [
  { index: true, element: <PcpPage /> },
  { path: 'pcp', element: <PcpPage /> },
  { path: 'table', element: <TablePage /> },
  { path: 'distribution', element: <DistributionPage /> },
  { path: 'likert', element: <LikertComparisonPage /> },
  { path: 'relationships', element: <RelationshipsPage /> },
  { path: 'clusters', element: <ClustersPage /> },
  { path: 'models', element: <ModelsPage /> },
  { path: 'pca', element: <PcaPage /> },
  { path: 'touring', element: <TgtPage /> },
  { path: 'mosaic', element: <LineMosaicPage /> },
  { path: 'overview', element: <OverviewPage /> },
  { path: 'statistics', element: <StatisticsPage /> },
  { path: 'ranking', element: <FeatureRankingPage /> },
  { path: 'subgroups', element: <SubgroupMiningPage /> },
  { path: 'associations', element: <SurpriseAssociationView /> },
  { path: 'robustness', element: <RobustnessPage /> },
  { path: 'key-drivers', element: <KeyDriverAnalysisPage /> },
  { path: 'penalty-reward', element: <PenaltyRewardPage /> },
  { path: 'fedf', element: <FedfPage /> },
  { path: 'barchart', element: <BarChartPage /> },
  { path: 'loess', element: <LoessPlotPage /> },
  { path: 'covariance', element: <CovariancePage /> },
  { path: 'logistic', element: <LogisticRegressionPage /> },
  { path: 'discriminant', element: <DiscriminantAnalysisPage /> },
  { path: 'models/ca', element: <CorrespondenceAnalysisPage /> },
  { path: 'crosstab', element: <CrosstabPage /> },
]

const router = IS_STATIC_BUILD
  ? createHashRouter([
      {
        path: '/',
        element: <AppShell />,
        children: routeChildren,
      },
    ])
  : createBrowserRouter([
      {
        path: '/',
        element: <AppShell />,
        children: routeChildren,
      },
    ])

const AppRoot: React.FC = () => {
  const [isReady, setIsReady] = useState(!IS_STATIC_BUILD)

  useEffect(() => {
    if (IS_STATIC_BUILD) {
      if (pyodideClient.getStatus().stage === 'ready') {
        setIsReady(true)
      }
    }
  }, [])

  if (IS_STATIC_BUILD && !isReady) {
    return <WasmLoadingScreen onReady={() => setIsReady(true)} />
  }

  return (
    <Provider store={store}>
      <ConfigProvider locale={jaJP} theme={{ algorithm: antdTheme.defaultAlgorithm }}>
        <FocusModeProvider>
          <RouterProvider router={router} />
        </FocusModeProvider>
      </ConfigProvider>
    </Provider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppRoot />
  </React.StrictMode>,
)
