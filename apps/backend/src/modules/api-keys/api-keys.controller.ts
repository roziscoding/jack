import type { ApiKeysRepository, UpdateApiKeyInput } from './api-keys.repository'
import { generateApiKey, hashKey } from '../../lib/crypto'
import { NotFoundError } from '../../lib/errors/NotFoundError'

export interface CreateApiKeyRequest {
  name?: string | null
  description?: string | null
  expiresAt?: string | null
}

export interface ApiKeyResponse {
  id: number
  name: string | null
  description: string | null
  expiresAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateApiKeyResponse extends ApiKeyResponse {
  key: string
}

export class ApiKeysController {
  constructor(private readonly repository: ApiKeysRepository) {}

  create(input: CreateApiKeyRequest): CreateApiKeyResponse {
    const rawKey = generateApiKey()
    const keyHash = hashKey(rawKey)

    const record = this.repository.create({
      keyHash,
      name: input.name,
      description: input.description,
      expiresAt: input.expiresAt,
    })

    return {
      id: record.id,
      key: rawKey,
      name: record.name,
      description: record.description,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  list(): ApiKeyResponse[] {
    return this.repository.list().map(record => ({
      id: record.id,
      name: record.name,
      description: record.description,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }))
  }

  get(id: number): ApiKeyResponse {
    const record = this.repository.get(id)
    if (!record) {
      throw new NotFoundError(`API key ${id} not found`)
    }

    return {
      id: record.id,
      name: record.name,
      description: record.description,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  update(id: number, input: UpdateApiKeyInput): ApiKeyResponse {
    const record = this.repository.update(id, input)
    if (!record) {
      throw new NotFoundError(`API key ${id} not found`)
    }

    return {
      id: record.id,
      name: record.name,
      description: record.description,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  delete(id: number): { ok: true } {
    const deleted = this.repository.delete(id)
    if (!deleted) {
      throw new NotFoundError(`API key ${id} not found`)
    }

    return { ok: true }
  }
}
