export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const session = await getManagementSession(event)
  await session.clear()
  return { status: 'ok' as const }
})
