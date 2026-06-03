import type { Context } from 'hono'
import type { ResponseHeader } from 'hono/utils/headers'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { BaseMime } from 'hono/utils/mime'
import { create } from 'xmlbuilder2'

type HeaderRecord = Record<'Content-Type', BaseMime> | Record<ResponseHeader, string | string[]> | Record<string, string | string[]>

function encodeXml(data: Record<string, any>): string {
  return create({ encoding: 'UTF-8' }, data).end({ spaceBeforeSlash: true })
}
export function xml<TData extends Record<string, any>>(c: Context, data: TData, status: ContentfulStatusCode = 200, headers?: HeaderRecord) {
  return c.body(encodeXml(data), status, { ...headers, 'Content-Type': 'application/xml' })
}
