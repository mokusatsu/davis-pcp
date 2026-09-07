import { useMemo, useState } from 'react'
import { Button, Collapse, Input, Modal, Space, Tag, Typography } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import licensesData from '../../data/licenses.json'

export interface LicensePackage {
  name: string
  category: string
  version?: string
  license: string
  repository?: string
  copyright: string
  text: string
}

export function LicenseContent() {
  const [searchTerm, setSearchTerm] = useState('')

  const packages = (licensesData.packages || []) as LicensePackage[]

  const filteredPackages = useMemo(() => {
    if (!searchTerm.trim()) return packages
    const term = searchTerm.toLowerCase()
    return packages.filter(
      (pkg) =>
        pkg.name.toLowerCase().includes(term) ||
        pkg.license.toLowerCase().includes(term) ||
        pkg.category.toLowerCase().includes(term)
    )
  }, [packages, searchTerm])

  const collapseItems = useMemo(
    () =>
      filteredPackages.map((pkg) => ({
        key: pkg.name,
        label: (
          <Space wrap size={[6, 4]}>
            <Typography.Text strong style={{ fontSize: 13 }}>
              {pkg.name}
            </Typography.Text>
            <Tag color={pkg.category === 'frontend' ? 'blue' : pkg.category === 'backend' ? 'cyan' : 'geekblue'}>
              {pkg.category}
            </Tag>
            <Tag color="green">{pkg.license}</Tag>
            {pkg.version && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                v{pkg.version}
              </Typography.Text>
            )}
          </Space>
        ),
        children: (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {pkg.repository && (
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Repository:{' '}
                </Typography.Text>
                <a href={pkg.repository} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12 }}>
                  {pkg.repository}
                </a>
              </div>
            )}
            <div style={{ fontSize: 12, fontWeight: 500, color: '#374151' }}>{pkg.copyright}</div>
            <pre
              style={{
                backgroundColor: '#f9fafb',
                border: '1px solid #e5e7eb',
                borderRadius: 4,
                padding: '8px 12px',
                fontSize: 11,
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: 220,
                overflowY: 'auto',
                margin: 0,
                fontFamily: 'Consolas, Monaco, "Courier New", monospace',
              }}
            >
              {pkg.text}
            </pre>
          </div>
        ),
      })),
    [filteredPackages]
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 12 }}>
      {/* Author Card */}
      <div
        data-testid="author-info"
        style={{
          padding: '12px 16px',
          backgroundColor: '#f8fafc',
          border: '1px solid #e2e8f0',
          borderRadius: 6,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <Typography.Text strong style={{ fontSize: 14, color: '#1e293b' }}>
          Author:
        </Typography.Text>
        <Typography.Text style={{ fontSize: 14, color: '#0f172a' }}>
          {licensesData.author || 'Keiji Okamoto'}
        </Typography.Text>
      </div>

      {/* OSS Licenses Header & Search */}
      <div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 8,
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <Typography.Text strong style={{ fontSize: 14 }}>
            OSS License一覧 ({filteredPackages.length}/{packages.length})
          </Typography.Text>
          <Input
            data-testid="license-search-input"
            placeholder="OSS名またはライセンスで検索..."
            prefix={<SearchOutlined style={{ color: '#9ca3af' }} />}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            allowClear
            style={{ width: 240 }}
            size="small"
          />
        </div>

        {/* Accordion */}
        <div data-testid="license-accordion">
          {collapseItems.length > 0 ? (
            <Collapse items={collapseItems} />
          ) : (
            <Typography.Text type="secondary" style={{ display: 'block', textAlign: 'center', padding: 24 }}>
              該当するOSSライセンスが見つかりません。
            </Typography.Text>
          )}
        </div>
      </div>
    </div>
  )
}

interface LicenseModalProps {
  open: boolean
  onClose: () => void
  getContainer?: false | HTMLElement | (() => HTMLElement)
}

export default function LicenseModal({ open, onClose, getContainer }: LicenseModalProps) {
  return (
    <Modal
      title={<Typography.Title level={4} style={{ margin: 0 }}>License Information</Typography.Title>}
      open={open}
      onCancel={onClose}
      getContainer={getContainer}
      style={{ top: 24 }}
      footer={[
        <Button key="close" type="primary" onClick={onClose}>
          閉じる
        </Button>,
      ]}
      width={780}
      styles={{
        body: {
          maxHeight: 'calc(100vh - 160px)',
          overflowY: 'auto',
          paddingRight: 8,
        },
      }}
    >
      <LicenseContent />
    </Modal>
  )
}
