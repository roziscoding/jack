import z from 'zod'

export const CreateQuickLinkBody = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).nullish(),
  expiresAt: z.string().datetime().nullish(),
})

export type CreateQuickLinkBody = z.infer<typeof CreateQuickLinkBody>
