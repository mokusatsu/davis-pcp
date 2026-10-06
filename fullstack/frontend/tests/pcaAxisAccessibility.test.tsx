import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import { BiplotView } from '../src/features/pca/BiplotView'
import { GraphExpansionProvider } from '../src/features/common/GraphExpansion'
import type { PcaResponse } from '../src/features/pca/types'

// Keep the real Ant Design controls and graph host/session; chart rendering has separate coverage.
vi.mock('../src/features/charts/RowScatter', () => ({ default: () => null }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

async function chooseByKeyboard(input: HTMLElement, current: string, next: string, steps: number) {
  fireEvent.mouseDown(input)
  const activeOption = () => document.getElementById(input.getAttribute('aria-activedescendant')!)
  await waitFor(() => expect(activeOption()).toHaveAccessibleName(current))
  for (let step = 0; step < steps; step++) {
    fireEvent.keyDown(input, { key: 'ArrowDown', keyCode: 40, which: 40 })
    fireEvent.keyUp(input, { key: 'ArrowDown', keyCode: 40, which: 40 })
  }
  expect(activeOption()).toHaveAccessibleName(next)
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, which: 13 })
  fireEvent.keyUp(input, { key: 'Enter', keyCode: 13, which: 13 })
  await waitFor(() => expect(input).toHaveAttribute('aria-expanded', 'false'))
}

it.each([true, false])('names the real PCA axis inputs and preserves direct numeric choices through expansion (correlation=%s)', async useCorrelation => {
  const pcaData: PcaResponse = {
    columns: ['x', 'y', 'z'], nSamples: 2, nComponents: 3, useCorrelation,
    eigenvalues: [5, 3, 2], explainedVarianceRatio: [.5, .3, .2], cumulativeVarianceRatio: [.5, .8, 1],
    kaiserThreshold: 1, kaiserThresholdComponents: 3, eigenvectors: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    loadings: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
    scores: [{ rowId: 'r1', pc: [-1, 0, 1] }, { rowId: 'r2', pc: [1, 0, -1] }], evidenceClass: 'test',
  }
  const originalResult = structuredClone(pcaData)
  const base = store.getState()
  const initial = { ...base, selection: { ...base.selection, selectedRowIds: ['r1'] } }
  const local = configureStore({ reducer: () => initial, middleware: getDefault => getDefault({ serializableCheck: false }) })
  const dispatch = vi.spyOn(local, 'dispatch')
  const onSelectX = vi.fn(), onSelectY = vi.fn()
  function Axes() {
    const [x, setX] = useState(0), [y, setY] = useState(1)
    return <BiplotView pcaData={pcaData} selectedX={x} selectedY={y}
      onSelectX={value => { onSelectX(value); setX(value) }} onSelectY={value => { onSelectY(value); setY(value) }} />
  }
  render(<Provider store={local}><GraphExpansionProvider><Axes /></GraphExpansionProvider></Provider>)
  const x = screen.getByRole('combobox', { name: '通常PCAのX軸', exact: true })
  const y = screen.getByRole('combobox', { name: '通常PCAのY軸', exact: true })
  expect(x).toBeInstanceOf(HTMLInputElement)
  expect(y).toBeInstanceOf(HTMLInputElement)
  expect(within(screen.getByTestId('pca-axis-x')).getByRole('combobox')).toBe(x)
  expect(within(screen.getByTestId('pca-axis-y')).getByRole('combobox')).toBe(y)
  expect(screen.getByText('X軸:')).toBeVisible()
  expect(screen.getByText('Y軸:')).toBeVisible()
  const expectValues = (xLabel: string, yLabel: string) => {
    expect(within(screen.getByTestId('pca-axis-x')).getByText(xLabel, { exact: true })).toBeVisible()
    expect(within(screen.getByTestId('pca-axis-y')).getByText(yLabel, { exact: true })).toBeVisible()
  }
  expectValues('PC1 (50.0%)', 'PC2 (30.0%)')
  await chooseByKeyboard(x, 'PC1 (50.0%)', 'PC3 (20.0%)', 2)
  expect(onSelectX.mock.calls).toEqual([[2]])
  expect(onSelectY).not.toHaveBeenCalled()
  expectValues('PC3 (20.0%)', 'PC2 (30.0%)')

  const host = screen.getByTestId('graph-host-pca/biplot')
  const slot = screen.getByTestId('graph-slot-pca/biplot')
  fireEvent.click(screen.getByRole('button', { name: 'PCAバイプロットを拡大表示', exact: true }))
  const dialog = await screen.findByRole('dialog', { name: 'PCAバイプロット', exact: true })
  expect(dialog).toContainElement(host)
  expect(within(dialog).getByRole('combobox', { name: '通常PCAのX軸', exact: true })).toBe(x)
  expect(within(dialog).getByRole('combobox', { name: '通常PCAのY軸', exact: true })).toBe(y)
  // Dropdowns directly assign axes, including equal X/Y; scree swaps are a separate contract.
  await chooseByKeyboard(y, 'PC2 (30.0%)', 'PC3 (20.0%)', 1)
  expect(onSelectY.mock.calls).toEqual([[2]])
  expect(onSelectX.mock.calls).toEqual([[2]])
  expectValues('PC3 (20.0%)', 'PC3 (20.0%)')
  fireEvent.click(within(dialog).getByRole('button', { name: '拡大を戻す', exact: true }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(slot).toContainElement(host)
  expect(screen.getByRole('combobox', { name: '通常PCAのX軸', exact: true })).toBe(x)
  expect(screen.getByRole('combobox', { name: '通常PCAのY軸', exact: true })).toBe(y)
  expectValues('PC3 (20.0%)', 'PC3 (20.0%)')
  await chooseByKeyboard(x, 'PC3 (20.0%)', 'PC1 (50.0%)', 1)
  expect(onSelectX.mock.calls).toEqual([[2], [0]])
  expect(onSelectY.mock.calls).toEqual([[2]])
  expectValues('PC1 (50.0%)', 'PC3 (20.0%)')
  expect(dispatch).not.toHaveBeenCalled()
  expect(local.getState().selection.selectedRowIds).toEqual(['r1'])
  expect(pcaData).toEqual(originalResult)
})
