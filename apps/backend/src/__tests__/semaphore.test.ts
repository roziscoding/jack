import { describe, expect, test } from 'bun:test'
import { Semaphore } from '../lib/semaphore'

describe('Semaphore', () => {
  test('limits concurrency to the permit count', async () => {
    const sem = new Semaphore(2)
    let active = 0
    let maxActive = 0
    const task = () => sem.run(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await Bun.sleep(10)
      active--
    })
    await Promise.all(Array.from({ length: 6 }, task))
    expect(maxActive).toBe(2)
  })

  test('hands permits to waiters in FIFO order', async () => {
    const sem = new Semaphore(1)
    const order: number[] = []
    await sem.acquire()
    const waiters = [1, 2, 3].map(n => sem.acquire().then(() => {
      order.push(n)
    }))
    sem.release()
    sem.release()
    sem.release()
    await Promise.all(waiters)
    expect(order).toEqual([1, 2, 3])
  })

  test('releases the permit when the task throws', async () => {
    const sem = new Semaphore(1)
    await expect(sem.run(async () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')
    const ran = await sem.run(async () => 'next')
    expect(ran).toBe('next')
  })

  test('removes an aborted waiter without consuming the next released permit', async () => {
    const sem = new Semaphore(1)
    await sem.acquire()
    const controller = new AbortController()
    const aborted = sem.acquire(controller.signal)
    const next = sem.acquire()

    controller.abort(new Error('cancelled while queued'))
    await expect(aborted).rejects.toThrow('cancelled while queued')
    sem.release()
    await next
  })

  test('does not run work when its signal aborts while queued', async () => {
    const sem = new Semaphore(1)
    await sem.acquire()
    const controller = new AbortController()
    let ran = false
    const queued = sem.run(async () => {
      ran = true
    }, controller.signal)

    controller.abort(new Error('cancelled while queued'))
    await expect(queued).rejects.toThrow('cancelled while queued')
    expect(ran).toBe(false)
    sem.release()
  })

  test('rejects a non-positive permit count', () => {
    expect(() => new Semaphore(0)).toThrow()
  })
})
