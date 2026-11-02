import type { LocationQuery, LocationQueryValue, Router } from 'vue-router'

export type QueryStringValue = string | number | boolean | string[]
type RawQueryValue = LocationQueryValue | LocationQueryValue[] | undefined

/** Parse a raw query value into the shape of `defaultValue`, falling back to it. */
export function parseQueryValue(raw: RawQueryValue, defaultValue: QueryStringValue): QueryStringValue {
  if (Array.isArray(defaultValue)) {
    const list = (Array.isArray(raw)
      ? raw
      : [raw]).filter((v): v is string => !!v)
    return (raw === undefined
      ? [...defaultValue]
      : list)
  }
  const first = Array.isArray(raw)
    ? raw[0]
    : raw
  if (first == null)
    return defaultValue
  if (typeof defaultValue === 'boolean') {
    if (first === 'true' || first === '1')
      return true
    if (first === 'false' || first === '0')
      return false
    return defaultValue
  }
  if (typeof defaultValue === 'number') {
    const n = Number(first)
    return (first !== '' && Number.isFinite(n)
      ? n
      : defaultValue)
  }
  return first
}

/** The query value for `value`, or undefined when it equals the default (key removed). */
export function serializeQueryValue(value: QueryStringValue, defaultValue: QueryStringValue): string | string[] | undefined {
  if (isSameValue(value, defaultValue))
    return undefined
  return Array.isArray(value)
    ? value
    : String(value)
}

export function isSameValue(a: QueryStringValue, b: QueryStringValue): boolean {
  if (Array.isArray(a) || Array.isArray(b))
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i])
  return a === b
}

// Refs changed in the same tick (e.g. a "clear filters" button) are merged into a
// single router.replace. Separate replaces would each start from the query as it was
// before the others landed, so all but the last change would be lost.
const pending = new WeakMap<Router, Record<string, string | string[] | undefined>>()

function scheduleQueryUpdate(router: Router, key: string, value: string | string[] | undefined) {
  let patch = pending.get(router)
  if (!patch) {
    patch = {}
    pending.set(router, patch)
    queueMicrotask(() => {
      const changes = pending.get(router) ?? {}
      pending.delete(router)
      const query: LocationQuery = { ...router.currentRoute.value.query }
      for (const [k, v] of Object.entries(changes)) {
        if (v === undefined)
          delete query[k]
        else
          query[k] = v
      }
      router.replace({ query })
    })
  }
  patch[key] = value
}

/**
 * A ref mirrored to the `key` query parameter. The value is parsed into the type of
 * `defaultValue`, and the parameter is dropped from the URL while the value equals
 * the default. Back/forward navigation updates the ref too.
 *
 * String refs don't infer a literal type from the default; pass the union
 * explicitly when the value is an enum: `useQueryString<'all' | 'tv'>('type', 'all')`.
 */
export function useQueryString(key: string, defaultValue: boolean): Ref<boolean>
export function useQueryString(key: string, defaultValue: number): Ref<number>
export function useQueryString(key: string, defaultValue: string[]): Ref<string[]>
export function useQueryString<T extends string = string>(key: string, defaultValue: NoInfer<T>): Ref<T>
export function useQueryString(key: string, defaultValue: QueryStringValue): Ref<QueryStringValue> {
  const route = useRoute()
  const router = useRouter()
  const value = ref(parseQueryValue(route.query[key], defaultValue)) as Ref<QueryStringValue>

  watch(value, (next) => {
    scheduleQueryUpdate(router, key, serializeQueryValue(next, defaultValue))
  }, { deep: true })

  watch(() => route.query[key], (raw) => {
    const parsed = parseQueryValue(raw, defaultValue)
    if (!isSameValue(parsed, value.value))
      value.value = parsed
  })

  return value
}
