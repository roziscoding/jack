<script setup lang="ts">
import type { DownloadItem } from '~/types/management'

const props = defineProps<{ download: DownloadItem }>()

const details = computed(() => props.download.errorDetails)
const hasFailure = computed(() => Boolean(props.download.error || props.download.errorCode))

// With structured details, the explanation leads and the raw message is
// redundant. Without them, the message's first line leads and the rest follows.
const messageLines = computed(() => (props.download.error ?? '').split('\n').map(line => line.trim()).filter(Boolean))
const headline = computed(() => details.value ? asSentence(details.value.explanation) : (messageLines.value[0] ?? ''))
const extraLines = computed(() => details.value ? [] : messageLines.value.slice(1))
const rows = computed(() => details.value ? inspectionRows(details.value) : [])

const SIZE_SOURCES: Record<NonNullable<DownloadItem['expectedBytesSource']>, string> = {
  content_length: 'the peer (Content-Length)',
  content_range: 'the peer (Content-Range)',
  release_size: 'the release metadata',
}

const requestedBy = computed(() => {
  const d = props.download
  if (d.importMode === 'jack_manual')
    return 'Catalog request'
  if (d.qbSourceServer)
    return d.qbCategory ? `${d.qbSourceServer}, category ${d.qbCategory}` : d.qbSourceServer
  return 'Unknown'
})
</script>

<template>
  <!-- UTable cells are nowrap; the details are prose and must wrap. -->
  <div class="space-y-5 whitespace-normal">
    <!-- The failure leads: what went wrong, then what jack saw on disk. -->
    <section v-if="hasFailure" class="space-y-3 border-l-2 border-error pl-4" aria-label="Failure">
      <div class="space-y-1">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <ULink
            v-if="download.errorCode"
            :to="errorCodeUrl(download.errorCode)"
            target="_blank"
            :title="`What ${download.errorCode} means and how to fix it`"
          >
            <UBadge color="error" variant="subtle" size="sm" class="font-mono" trailing-icon="i-ph-arrow-square-out">
              {{ download.errorCode }}
            </UBadge>
          </ULink>
          <p class="text-sm font-medium text-highlighted">
            {{ headline }}
          </p>
        </div>
        <p v-if="details" class="text-xs text-muted">
          While {{ details.operation }},
          <time :datetime="details.occurred_at" :title="formatDate(details.occurred_at)">{{ formatAgo(details.occurred_at) }} ago</time>
          <span class="text-dimmed">({{ details.errno }})</span>
        </p>
        <p v-for="(line, index) in extraLines" :key="index" class="text-xs break-words text-muted">
          {{ line }}
        </p>
      </div>

      <!-- Laid out like `ls -l`: the vocabulary of whoever fixes this. -->
      <div v-if="rows.length" class="overflow-x-auto">
        <table class="w-full text-xs">
          <tbody>
            <tr v-for="row in rows" :key="row.label" class="align-baseline">
              <th scope="row" class="py-0.5 pr-4 text-left font-normal whitespace-nowrap text-muted">
                {{ row.label }}
              </th>
              <td class="max-w-0 py-0.5 pr-4 font-mono text-default">
                <span class="block truncate" :title="row.entry.path">{{ row.entry.path }}</span>
              </td>
              <template v-if="row.entry.exists">
                <td class="py-0.5 pr-4 font-mono whitespace-nowrap text-default" :title="`Mode ${row.entry.mode_octal}`">
                  {{ row.entry.mode }}
                </td>
                <td class="py-0.5 pr-4 font-mono whitespace-nowrap text-muted" title="Owner uid:gid">
                  {{ row.entry.uid }}:{{ row.entry.gid }}
                </td>
                <td class="py-0.5 text-right whitespace-nowrap text-muted tabular-nums">
                  {{ row.entry.size_bytes == null ? '' : formatBytes(row.entry.size_bytes) }}
                </td>
              </template>
              <td v-else colspan="3" class="py-0.5 whitespace-nowrap text-error">
                {{ row.entry.stat_error === 'ENOENT' ? 'Does not exist' : `Could not inspect (${row.entry.stat_error})` }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="details && (details.free_space || details.process)" class="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted">
        <p v-if="details.free_space">
          <template v-if="'bytes_available' in details.free_space">
            {{ formatBytes(details.free_space.bytes_available) }} free, {{ details.free_space.inodes_free.toLocaleString() }} inodes left
          </template>
          <template v-else>
            Free space unknown ({{ details.free_space.statfs_error }})
          </template>
        </p>
        <p v-if="details.process">
          jack runs as <span class="font-mono text-default">{{ details.process.uid }}:{{ details.process.gid }}</span>
          <span v-if="details.process.groups" class="text-dimmed">(groups {{ details.process.groups }})</span>
        </p>
      </div>
    </section>

    <!-- Facts for every download, grouped by what they answer. -->
    <div class="grid gap-x-8 gap-y-4 text-xs sm:grid-cols-2 xl:grid-cols-4">
      <dl class="space-y-1">
        <dt class="text-sm font-medium text-highlighted">
          Transfer
        </dt>
        <dd class="text-default tabular-nums">
          {{ formatBytes(download.downloadedBytes) }} of {{ formatBytes(download.totalBytes) }}
        </dd>
        <dd v-if="download.expectedBytesSource" class="text-muted">
          Size from {{ SIZE_SOURCES[download.expectedBytesSource] }}
        </dd>
        <dd v-if="download.expectedBytesMismatch" class="text-warning">
          Differs from the release size ({{ formatBytes(download.releaseSize) }})
        </dd>
        <dd class="text-muted">
          {{ download.attempts }} {{ download.attempts === 1 ? 'attempt' : 'attempts' }}
        </dd>
      </dl>

      <dl class="space-y-1">
        <dt class="text-sm font-medium text-highlighted">
          Timeline
        </dt>
        <dd class="text-muted">
          Started <time :datetime="download.startedAt" class="text-default">{{ formatDate(download.startedAt) }}</time>
        </dd>
        <dd v-if="download.completedAt" class="text-muted">
          Transferred <time :datetime="download.completedAt" class="text-default">{{ formatDate(download.completedAt) }}</time>
        </dd>
        <dd class="text-muted">
          Updated <time :datetime="download.updatedAt" class="text-default">{{ formatDate(download.updatedAt) }}</time>
        </dd>
      </dl>

      <dl class="min-w-0 space-y-1">
        <dt class="text-sm font-medium text-highlighted">
          Files
        </dt>
        <dd class="text-muted">
          Final
        </dd>
        <dd class="truncate font-mono text-default" :title="download.destPath">
          {{ download.destPath }}
        </dd>
        <dd class="text-muted">
          While downloading
        </dd>
        <dd class="truncate font-mono text-default" :title="download.partPath">
          {{ download.partPath }}
        </dd>
      </dl>

      <dl class="min-w-0 space-y-1">
        <dt class="text-sm font-medium text-highlighted">
          Source
        </dt>
        <dd class="text-default">
          {{ requestedBy }}
        </dd>
        <dd class="text-muted">
          From {{ download.peerName }}
        </dd>
        <dd class="truncate font-mono text-muted" :title="download.itemId">
          {{ download.itemId }}
        </dd>
      </dl>
    </div>
  </div>
</template>
