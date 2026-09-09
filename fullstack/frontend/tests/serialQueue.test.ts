import { expect, it } from 'vitest'
import { createSerialQueue } from '../src/engine/serialQueue'

it('waits for the active operation and continues after a failed request', async () => {
  const enqueue = createSerialQueue()
  const events: string[] = []
  let release!: () => void
  const paused = new Promise<void>(resolve => { release = resolve })
  const first = enqueue(async () => { events.push('start'); await paused; events.push('finish') })
  const failed = enqueue(async () => { events.push('failure'); throw new Error('request failed') })
  const last = enqueue(async () => { events.push('next'); return 39 })
  const failure = expect(failed).rejects.toThrow('request failed')
  await Promise.resolve()
  expect(events).toEqual(['start'])
  release()
  await first
  await failure
  expect(await last).toBe(39)
  expect(events).toEqual(['start', 'finish', 'failure', 'next'])
})
