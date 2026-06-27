/**
 * Renders the first image source that successfully loads, falling back through the
 * rest on error. TMDB image requests occasionally fail under load (many posters
 * fetching at once), which otherwise leaves a permanently blank box until a reload
 * warms the HTTP cache. Falling back to the next candidate — typically an image the
 * sibling view already cached — keeps artwork on screen; when every source fails,
 * `src` is null so the caller can show its placeholder instead of a broken image.
 */
export function useFallbackImage(sources: () => Array<string | null | undefined>) {
  const candidates = computed(() => sources().filter((s): s is string => Boolean(s)))
  const index = ref(0)
  const exhausted = ref(false)

  const src = computed(() => (exhausted.value ? null : candidates.value[index.value] ?? null))

  function onError(): void {
    if (index.value < candidates.value.length - 1)
      index.value += 1
    else
      exhausted.value = true
  }

  // Reset the cursor when the actual list of URLs changes (e.g. the sidebar swaps
  // to a different title), but not on unrelated reactive churn.
  watch(() => candidates.value.join('|'), () => {
    index.value = 0
    exhausted.value = false
  })

  return { src, onError }
}
