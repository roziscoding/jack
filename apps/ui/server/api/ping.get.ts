// The UI's four-state auth probe (mirrors the design doc):
//   ok          → key valid, management API up
//   needs-key   → cookie mode, no/invalid key → prompt for it
//   disabled    → management API unreachable (server has no MANAGEMENT_KEY set)
//   error       → env-injected key rejected, or an unexpected upstream status
export default defineEventHandler(async (event) => {
  const { key, mode } = await resolveKey(event)
  const probe = await probeUpstream(event, key)

  if (!probe.reachable)
    return { status: 'disabled' as const, mode }

  if (probe.status === 200)
    return { status: 'ok' as const, mode }

  if (probe.status === 401) {
    if (mode === 'env') {
      return {
        status: 'error' as const,
        mode,
        message: 'The MANAGEMENT_KEY configured for the UI was rejected by the management API.',
      }
    }
    return { status: 'needs-key' as const, mode }
  }

  return { status: 'error' as const, mode, message: `Unexpected management API status ${probe.status}.` }
})
