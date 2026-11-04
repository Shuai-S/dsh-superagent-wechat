/** Defensive outbound pacing per account: serial queue, >=3s spacing
 *  (~20 messages/min), and a hard cap of 20 sends / 60s — exceeding the cap
 *  throws so the Outbox backs off with its own retry schedule. This is a
 *  client-side courtesy limit only; the real risk control sits server-side. */

const MIN_INTERVAL_MS = 3_000
const WINDOW_MS = 60_000
const WINDOW_MAX = 20

interface Gate {
  chain: Promise<unknown>
  lastSentAt: number
  sent: number[]
}

const gates = new Map<string, Gate>()

function gateOf(accountId: string): Gate {
  let gate = gates.get(accountId)
  if (!gate) {
    gate = { chain: Promise.resolve(), lastSentAt: 0, sent: [] }
    gates.set(accountId, gate)
  }
  return gate
}

export function withSendSlot<T>(accountId: string, run: () => Promise<T>): Promise<T> {
  const gate = gateOf(accountId)
  const task = gate.chain.then(async () => {
    const now = Date.now()
    gate.sent = gate.sent.filter((at) => now - at < WINDOW_MS)
    if (gate.sent.length >= WINDOW_MAX) {
      throw new Error('wechat: outbound rate limit reached (defensive cap 20/min); the Outbox will retry with backoff')
    }
    const wait = gate.lastSentAt + MIN_INTERVAL_MS - now
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    const at = Date.now()
    gate.lastSentAt = at
    gate.sent.push(at)
    return run()
  })
  gate.chain = task.catch(() => undefined)
  return task
}
