import type { ApiKeyResponse, ApiKeysController } from '../api-keys/api-keys.controller'
import type { ConfigService } from '../config/config.service'
import type { CreateQuickLinkBody } from './quick-links.schema'
import { Buffer } from 'node:buffer'
import { z } from 'zod'
import { BadRequestError } from '../../lib/errors/BadRequestError'

export interface QuickLinkPayload {
  v: 1
  type: 'peer'
  name: string
  url: string
  apiKey: string
  headers: Record<string, string>
}

export interface CreateQuickLinkResponse {
  link: string
  key: ApiKeyResponse
}

export function encodeQuickLink(payload: QuickLinkPayload): string {
  const link = `jack-link:v1:${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`
  if (link.length > 32_768)
    throw new BadRequestError('The configured external access profile is too large for a quick link')
  return link
}

export class QuickLinksController {
  constructor(
    private readonly configService: ConfigService,
    private readonly apiKeysController: ApiKeysController,
  ) {}

  create(input: CreateQuickLinkBody): CreateQuickLinkResponse {
    // Resolve every ConfigSecret before issuing a credential. A broken or missing
    // external profile therefore cannot leave an orphan API key behind.
    let external
    try {
      external = this.configService.getResolvedExternalJack()
    }
    catch (error) {
      if (error instanceof z.ZodError)
        throw new BadRequestError('The external access profile contains a secret that could not be resolved')
      throw error
    }
    if (!external)
      throw new BadRequestError('Configure Jack external access before generating a quick link')

    const created = this.apiKeysController.create(input)
    const { key: rawKey, ...key } = created

    try {
      return {
        link: encodeQuickLink({
          v: 1,
          type: 'peer',
          name: input.name,
          url: external.url,
          apiKey: rawKey,
          headers: external.headers,
        }),
        key,
      }
    }
    catch (error) {
      // Encoding should be infallible for the validated string-only payload, but
      // compensate if that contract changes so a credential is never orphaned.
      this.apiKeysController.delete(created.id)
      throw error
    }
  }
}
