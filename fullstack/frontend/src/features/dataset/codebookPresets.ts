export interface CodebookPreset {
  id: string
  name: string
  scaleType: 'ordinal' | 'nominal'
  options: { code: string; label: string }[]
  isCustom?: boolean
}

const CUSTOM_PRESETS_STORAGE_KEY = 'davis_codebook_user_presets'

export function getCustomPresets(): CodebookPreset[] {
  try {
    const raw = localStorage.getItem(CUSTOM_PRESETS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveCustomPreset(
  name: string,
  options: { code: string; label: string }[],
  scaleType: 'ordinal' | 'nominal' = 'ordinal'
): CodebookPreset {
  const customPresets = getCustomPresets()
  const newPreset: CodebookPreset = {
    id: `custom_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    name,
    scaleType,
    options,
    isCustom: true,
  }
  const updated = [newPreset, ...customPresets]
  localStorage.setItem(CUSTOM_PRESETS_STORAGE_KEY, JSON.stringify(updated))
  return newPreset
}

export function deleteCustomPreset(presetId: string): CodebookPreset[] {
  const customPresets = getCustomPresets()
  const updated = customPresets.filter((p) => p.id !== presetId)
  localStorage.setItem(CUSTOM_PRESETS_STORAGE_KEY, JSON.stringify(updated))
  return updated
}

export function getAllPresets(): { custom: CodebookPreset[]; builtIn: CodebookPreset[] } {
  return {
    custom: getCustomPresets(),
    builtIn: CODEBOOK_PRESETS,
  }
}

export const CODEBOOK_PRESETS: CodebookPreset[] = [
  {
    id: 'satisfaction_5',
    name: '満足度 5段階 (1:大いに不満 〜 5:大いに満足)',
    scaleType: 'ordinal',
    options: [
      { code: '1', label: '大いに不満' },
      { code: '2', label: 'やや不満' },
      { code: '3', label: 'どちらでもない' },
      { code: '4', label: 'やや満足' },
      { code: '5', label: '大いに満足' },
    ],
  },
  {
    id: 'satisfaction_7',
    name: '満足度 7段階 (1:非常に不満 〜 7:非常に満足)',
    scaleType: 'ordinal',
    options: [
      { code: '1', label: '非常に不満' },
      { code: '2', label: '不満' },
      { code: '3', label: 'やや不満' },
      { code: '4', label: 'どちらでもない' },
      { code: '5', label: 'やや満足' },
      { code: '6', label: '満足' },
      { code: '7', label: '非常に満足' },
    ],
  },
  {
    id: 'agreement_5',
    name: '同意度 5段階 (1:全くそう思わない 〜 5:強くそう思う)',
    scaleType: 'ordinal',
    options: [
      { code: '1', label: '全くそう思わない' },
      { code: '2', label: 'そう思わない' },
      { code: '3', label: 'どちらともいえない' },
      { code: '4', label: 'そう思う' },
      { code: '5', label: '強くそう思う' },
    ],
  },
  {
    id: 'approval_4',
    name: '賛否 4段階 (1:反対 〜 4:賛成 / 中立なし)',
    scaleType: 'ordinal',
    options: [
      { code: '1', label: '反対' },
      { code: '2', label: 'どちらかといえば反対' },
      { code: '3', label: 'どちらかといえば賛成' },
      { code: '4', label: '賛成' },
    ],
  },
  {
    id: 'frequency_5',
    name: '頻度 5段階 (1:全く利用しない 〜 5:ほぼ毎日)',
    scaleType: 'ordinal',
    options: [
      { code: '1', label: '全く利用しない' },
      { code: '2', label: '月1回未満' },
      { code: '3', label: '月2-3回' },
      { code: '4', label: '週1-2回' },
      { code: '5', label: 'ほぼ毎日' },
    ],
  },
  {
    id: 'binary_yes_no',
    name: '二値 (0:いいえ, 1:はい)',
    scaleType: 'nominal',
    options: [
      { code: '0', label: 'いいえ' },
      { code: '1', label: 'はい' },
    ],
  },
  {
    id: 'binary_gender',
    name: '性別 (1:男性, 2:女性)',
    scaleType: 'nominal',
    options: [
      { code: '1', label: '男性' },
      { code: '2', label: '女性' },
    ],
  },
  {
    id: 'binary_presence',
    name: '有無 (0:非該当/無, 1:該当/有)',
    scaleType: 'nominal',
    options: [
      { code: '0', label: '非該当/無' },
      { code: '1', label: '該当/有' },
    ],
  },
]
