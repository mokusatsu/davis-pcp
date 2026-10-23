export const IS_STATIC_BUILD =
  import.meta.env.VITE_STATIC_BUILD === 'true' ||
  (typeof window !== 'undefined' && (window as any).__DAVIS_PCP_STATIC__ === true)
