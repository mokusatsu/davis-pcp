import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LicenseContent } from '../src/features/common/LicenseModal'
import licensesData from '../src/data/licenses.json'

describe('License Registry & Content Suite', () => {
  it('licenses.json contains author Keiji Okamoto and valid packages', () => {
    expect(licensesData.author).toBe('Keiji Okamoto')
    expect(Array.isArray(licensesData.packages)).toBe(true)
    expect(licensesData.packages.length).toBeGreaterThanOrEqual(10)

    for (const pkg of licensesData.packages) {
      expect(pkg.name).toBeTruthy()
      expect(pkg.license).toBeTruthy()
      expect(pkg.copyright).toBeTruthy()
      expect(pkg.text).toBeTruthy()
    }
  })

  it('renders Author: Keiji Okamoto and OSS license list', () => {
    render(<LicenseContent />)

    // Verify Author information
    const authorInfo = screen.getByTestId('author-info')
    expect(authorInfo).toHaveTextContent('Author:')
    expect(authorInfo).toHaveTextContent('Keiji Okamoto')

    // Verify OSS License header
    expect(screen.getByText(/OSS License一覧/)).toBeInTheDocument()

    // Verify major packages exist in the list
    expect(screen.getAllByText('react').length).toBeGreaterThan(0)
    expect(screen.getAllByText('antd').length).toBeGreaterThan(0)
    expect(screen.getAllByText('fastapi').length).toBeGreaterThan(0)
    expect(screen.getAllByText('polars').length).toBeGreaterThan(0)
  })

  it('filters packages when search query is entered', () => {
    render(<LicenseContent />)

    const searchInput = screen.getByTestId('license-search-input')
    fireEvent.change(searchInput, { target: { value: 'polars' } })

    expect(screen.getByText('polars')).toBeInTheDocument()
    // Other unrelated packages should be filtered out
    expect(screen.queryByText('fastapi')).not.toBeInTheDocument()
  })
})
