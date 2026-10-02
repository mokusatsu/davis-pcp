import { useEffect, useRef } from 'react'

/** A response belongs to one mounted instance, input identity and request generation. */
export function useRequestIdentity(key: string) {
  const identity = useRef(key)
  const generation = useRef(0)
  if (identity.current !== key) {
    identity.current = key
    generation.current++
  }
  useEffect(() => () => { generation.current++ }, [])
  return {
    invalidate: () => { generation.current++ },
    begin: () => {
      const startedKey = identity.current
      const startedGeneration = ++generation.current
      return () => identity.current === startedKey && generation.current === startedGeneration
    },
  }
}
