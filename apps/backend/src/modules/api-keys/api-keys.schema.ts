import z from 'zod'

export const CreateApiKeyBody = z.object({
  name: z.string().max(100).nullish(),
  description: z.string().max(500).nullish(),
  expiresAt: z.string().datetime().nullish(),
})

export type CreateApiKeyBody = z.infer<typeof CreateApiKeyBody>

export const UpdateApiKeyBody = z.object({
  name: z.string().max(100).nullish(),
  description: z.string().max(500).nullish(),
  expiresAt: z.string().datetime().nullish(),
})

export type UpdateApiKeyBody = z.infer<typeof UpdateApiKeyBody>
