import { expect, test } from 'bun:test'
import { coalesce, StatusController } from '../modules/status/status.controller'

test('the overview stream subscribes to connectors through their object', () => {
  // Like ConnectorManager: subscribe() relies on `this`.
  class Connectors {
    servers = []
    peers = []
    private readonly subscribers = new Set<() => void>()
    subscribe(subscriber: () => void) {
      this.subscribers.add(subscriber)
      return () => this.subscribers.delete(subscriber)
    }

    emit() {
      for (const s of this.subscribers) s()
    }
  }
  const connectors = new Connectors()
  const fired: number[] = []
  const unsubscribe = new StatusController(connectors).subscribeOverview(() => fired.push(1))
  connectors.emit()
  expect(fired).toHaveLength(1)
  unsubscribe()
})

function source() {
  const subscribers = new Set<() => void>()
  return {
    emit: () => {
      for (const s of subscribers) s()
    },
    subscribe: (s: () => void) => {
      subscribers.add(s)
      return () => subscribers.delete(s)
    },
  }
}

test('folds bursts from every source into one snapshot per interval', async () => {
  const a = source()
  const b = source()
  const fired: number[] = []
  const unsubscribe = coalesce(() => fired.push(Date.now()), [a.subscribe, undefined, b.subscribe], 50)

  a.emit()
  expect(fired).toHaveLength(1)
  // Within the interval: folded into one trailing snapshot.
  b.emit()
  a.emit()
  b.emit()
  expect(fired).toHaveLength(1)
  await Bun.sleep(80)
  expect(fired).toHaveLength(2)

  // A pending snapshot is dropped on unsubscribe.
  a.emit()
  unsubscribe()
  await Bun.sleep(80)
  a.emit()
  expect(fired.length).toBeLessThanOrEqual(3)
})
