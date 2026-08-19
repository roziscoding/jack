import z from 'zod'

export const CreateQuickLinkBody = z.object({
  peerName: z.string().trim().min(1).max(100),
  keyName: z.string().trim().min(1).max(100),
  keyDescription: z.string().max(500).nullish(),
  expiresAt: z.string().datetime().nullish(),
})

export type CreateQuickLinkBody = z.infer<typeof CreateQuickLinkBody>
