---
description: Diagnose jack connectivity, Radarr or Sonarr registration, qBittorrent client checks, downloads, imports, permissions, management UI live updates, and peer errors.
---

# Troubleshooting

Registration runs on every startup and logs the *arr response body, so check
`docker compose logs jack` first. The common failures:

## Radarr/Sonarr report failures talking to Jack

Once registered, *arr health checks and grabs can start failing with messages
like:

```
Unable to communicate with Jack.
Failed to connect to qBittorrent, please check your settings.
```

When *arr mentions **Jack** and **qBittorrent** in the same message, it's
talking about **jack's qBittorrent API**. jack registered itself as a
qBittorrent instance, and *arr can't tell the difference, so this **does not**
mean your own qBittorrent has a problem (if you even run one). Both the indexer
and the download client point at jack, so either way the failure is between
*arr and jack.

The usual causes:

- **jack isn't running.** Check `docker compose ps` / the container logs.
- **jack is unreachable from *arr.** Same networking story as
  [below](#qbittorrent-download-client-test-fails-failed-to-register-download-client):
  `jack.internalUrl` must resolve from the Radarr/Sonarr side.
- **The managed key is no longer valid**, for example after wiping jack's
  database. **Restart jack**: auto-registration runs again on startup and
  updates the registration with a fresh, valid key.

## qBittorrent download client test fails / `Failed to register download client`

The qBittorrent client *arr registers (or the ***Test*** button in
***Settings -> Download Clients***) connects to jack's qBittorrent API at the
host/port jack derives from `jack.internalUrl`. A failing test almost always
means *arr can't reach that address.

**Fix:** make sure `jack.internalUrl` is resolvable **from the Radarr/Sonarr
side**. On a shared Docker network use the container name (`http://jack:5225`);
otherwise the host IP/domain. If *arr and jack are on different networks, attach
jack to *arr's network (the `networks:` block in the example compose).

## Grabs download but never import

The download completes in jack (you see it finish in the logs) but Radarr/Sonarr
never pick the file up. jack writes finished files to the **literal**
`downloads.completedPath`, and *arr imports them by resolving that path in **its
own** filesystem, so the completed folder must exist at the **same path**
inside the Radarr/Sonarr containers.

**Fix:** mount the **same host folder** into Radarr **and** Sonarr at the **same
container path** jack uses. If jack has:

```yaml
# jack
volumes:
  - /srv/media/jack-completed:/data/torrents/completed
```

then Radarr and Sonarr each need:

```yaml
# radarr AND sonarr
volumes:
  - /srv/media/jack-completed:/data/torrents/completed
```

Two gotchas:

- **Use a dedicated completed folder.** Don't point `completedPath` at a folder
  another download client (e.g. a real qBittorrent's `/downloads`) already
  writes to, or *arr will try to import unrelated files.
- **Permissions.** jack runs as **uid/gid 1000**, matching the `PUID/PGID` the
  linuxserver.io *arr images default to, so files jack writes are owned by the
  same user that imports them. Make sure the completed folder (and the `/config`
  mount) are readable/writable by uid 1000, with `chown -R 1000:1000`. If your
  *arr uses a different `PUID`, set it to match.

## `No "downloads" config set`, no download client registered

```
No "downloads" config set; skipping download client auto-registration. Grabs will fail until a qBittorrent client is configured.
```

jack only registers the qBittorrent download client when a `downloads` block is
present in your config (it needs `completedPath` to know where to write files).
Without it, the Torznab indexer is still registered so searches work, but grabs
have nowhere to go.

**Fix:** add a `downloads` block with `completedPath` and restart jack.

If registration fails with `Failed to register indexer`, check that the
destination server is reachable and its API key is correct. Registration logs
the raw *arr response body at `error` level.

## `ConnectionRefused` on startup

```
Failed to initialize connector radarr: Unable to connect. Is the computer able to access the url?
```

jack tries to connect to your servers at boot. If it starts before Radarr/Sonarr
are ready, those connectors fail initially and you'll see `sources:0` /
`destinations:0` in the `Server listening` line. Source and peer connectors are
retried lazily the next time a search/download needs them, so they can recover
without a restart once the remote service is up.

Auto-registration still runs only during startup, so a destination that was down
at boot may need a jack restart before the Torznab indexer or qBittorrent
download client is created in Radarr/Sonarr. To make startup deterministic, wait
for the dependencies to be healthy:

```yaml
# jack
depends_on:
  radarr: {condition: service_healthy}
  sonarr: {condition: service_healthy}
```

(This needs `healthcheck` blocks on those services; the linuxserver.io images
ship with them.)

## The completed folder keeps growing

Everything imports fine, but `downloads.completedPath` never shrinks. Every
title you've ever grabbed is still sitting there.

That's the default behaviour, not a bug. Importing doesn't consume the file:
Radarr/Sonarr read it and write your library copy, and jack's copy stays put.
Whether that costs you real space depends on your *arr, since a hardlinked
import shares bytes with the library and a copied one doesn't, but either way
the folder fills up.

**Fix:** turn on
[`downloads.unlinkImportedFiles`](/reference/configuration#downloads-unlinkimportedfiles),
in `config.jsonc` or from ***Settings -> Downloads*** in the management UI. It
applies immediately, with no restart. jack then unlinks its copy as each import
is confirmed, and only then: one file per confirmed import, never your library.
Details in [After the import](/guide/how-it-works#after-the-import).

This only affects downloads imported **after** you enable it. Files already in
the folder are yours to clear out; deleting the download rows from the
management UI's Downloads page removes their files too.

## Download error codes

Every failed download carries an error code. On ***Downloads***, expand the
download to see its code, linked to its row below, and what went wrong. Logs
record the code as `error_code`.

For filesystem errors, jack also records what it found on disk when the error
happened: the errno, the operation, and the mode, owner, and size of the file
and its folder. The expanded download lays these out like `ls -l`, and the log
holds them in its `filesystem` field.

jack retries the codes marked **Retried** on its own, up to
[`downloads.maxDownloadAttempts`](/reference/configuration#downloads-maxdownloadattempts).
The code you see is the one from the last attempt. Every other code fails the
download at once; fix the cause, then use ***Retry*** on the download.

### Download file

The `.part` is the file jack writes while downloading. When the transfer
finishes, jack renames it into `downloads.completedPath`.

| Code | What happened | What to check |
|---|---|---|
| <span id="PART_DIR_MISSING">`PART_DIR_MISSING`</span> | The folder for the `.part` doesn't exist. | The volume is mounted and `completedPath` is right. |
| <span id="PART_CREATE_DENIED">`PART_CREATE_DENIED`</span> | jack can't create the `.part` in its folder. | The folder is writable by jack's uid (1000 by default). |
| <span id="PART_RESUME_DENIED">`PART_RESUME_DENIED`</span> | The `.part` from an earlier attempt exists, but jack can no longer open it. | Its permissions or owner changed since the last attempt. |
| <span id="PART_WRITE_DENIED">`PART_WRITE_DENIED`</span> | Writing to the open `.part` was refused. | Only network filesystems (NFS, SMB, FUSE) do this mid-transfer: check the share's permissions. |
| <span id="PART_DELETED">`PART_DELETED`</span> | The `.part` was deleted while jack wrote it. Those bytes are lost. | Cleanup scripts, another download client, or *arr touching the folder. |
| <span id="PART_MOVED">`PART_MOVED`</span> | The `.part` was moved or renamed while jack wrote it. | Same as `PART_DELETED`. |
| <span id="PART_REPLACED">`PART_REPLACED`</span> | Another file took the `.part`'s place, or an NFS server invalidated it. | Another process writing the same name. |
| <span id="DISK_FULL">`DISK_FULL`</span> | The disk is full, out of inodes, or jack's quota ran out. | Free space on the volume; the error shows what was available. |
| <span id="FILE_TOO_LARGE_FOR_FS">`FILE_TOO_LARGE_FOR_FS`</span> | The file is larger than the filesystem allows. | FAT32 caps files at 4 GiB. |
| <span id="FS_READ_ONLY">`FS_READ_ONLY`</span> | The filesystem is read-only. | A `:ro` mount, or a disk the kernel remounted read-only after errors. |
| <span id="DISK_IO_ERROR">`DISK_IO_ERROR`</span> | The disk or network share failed the write. | `dmesg` on the host, and the disk's health. |
| <span id="COMPLETED_MOVE_DENIED">`COMPLETED_MOVE_DENIED`</span> | The download finished, but jack can't move it into place. | Permissions on `completedPath`, or an existing file there owned by someone else. |
| <span id="COMPLETED_DIR_MISSING">`COMPLETED_DIR_MISSING`</span> | The download finished, but its destination folder doesn't exist. | The volume is still mounted. |
| <span id="CROSS_DEVICE_MOVE">`CROSS_DEVICE_MOVE`</span> | The `.part` and the destination are on different filesystems. | Keep both on the same mount. |
| <span id="INVALID_PATH">`INVALID_PATH`</span> | The path can't be used: a name too long, a symlink loop, or a folder where a file should be. | The release name and the folders in the path. |
| <span id="TOO_MANY_OPEN_FILES">`TOO_MANY_OPEN_FILES`</span> | jack or the host hit the open-file limit. The file is untouched. | `ulimit -n` for the container. |
| <span id="FILESYSTEM_ERROR">`FILESYSTEM_ERROR`</span> | Any other filesystem error. | The errno in the message. |

### Transfer

| Code | What happened | What to check | Retried |
|---|---|---|---|
| <span id="IDLE_TIMEOUT">`IDLE_TIMEOUT`</span> | The peer stopped sending data for longer than [`downloads.idleTimeoutMs`](/reference/configuration#downloads-idletimeoutms). | The peer's connection and load. | Yes |
| <span id="INCOMPLETE_DOWNLOAD">`INCOMPLETE_DOWNLOAD`</span> | The transfer ended before the whole file arrived. | The peer's connection. The next attempt resumes from the `.part`. | Yes |
| <span id="PEER_UNREACHABLE">`PEER_UNREACHABLE`</span> | jack couldn't connect to the peer. | The peer's URL and whether its jack is up. | Yes |
| <span id="PEER_HTTP_ERROR">`PEER_HTTP_ERROR`</span> | The peer answered with an HTTP error. | The status in the message: `404` means the peer no longer has the file. | `429` and `5xx` only |
| <span id="UNKNOWN_SIZE">`UNKNOWN_SIZE`</span> | Neither the peer nor *arr reported the file size, so jack can't verify the download. | A proxy in front of the peer that strips `Content-Length`. | No |
| <span id="PEER_NOT_FOUND">`PEER_NOT_FOUND`</span> | The download's peer was removed from the config. | Re-add the peer, or delete the download. | No |
| <span id="CANCELLED">`CANCELLED`</span> | You cancelled the download. The `.part` is kept. | Nothing; ***Retry*** resumes it. | No |
| <span id="SUPERSEDED">`SUPERSEDED`</span> | After a restart, another download for the same file resumed instead of this one. | Nothing; delete the duplicate. | No |
| <span id="STALE_AFTER_RESTART">`STALE_AFTER_RESTART`</span> | jack restarted mid-download, and the config has no `downloads` block to resume it with. | Add the [`downloads`](/reference/configuration#downloads) block back. | No |
| <span id="UNKNOWN_ERROR">`UNKNOWN_ERROR`</span> | An error jack doesn't classify yet. | The message and the logs. | No |

### Import

| Code | What happened | What to check |
|---|---|---|
| <span id="IMPORT_REJECTED">`IMPORT_REJECTED`</span> | Radarr/Sonarr rejected the manual import. | The reason in the message, and *arr's own logs. |
| <span id="IMPORT_TRIGGER_FAILED">`IMPORT_TRIGGER_FAILED`</span> | jack couldn't start the manual import in Radarr/Sonarr after repeated attempts. | That *arr is reachable from jack. |

## Management UI stuck on "Reconnecting..."

The Overview and Downloads pages show a ***Live*** badge while their
[event stream](/guide/management-ui#live-updates) is connected. If it sits on
***Reconnecting...***, or flips to it every few seconds, the stream is being
closed or buffered before it reaches the browser. The pages still load; they
just stop updating on their own.

The usual causes:

- **A reverse proxy is buffering the response.** SSE only works if the proxy
  streams bytes through. jack sends `X-Accel-Buffering: no` and the UI's BFF
  forwards it, which nginx honours; for others turn buffering off explicitly
  (`proxy_buffering off;` on nginx, `flush_interval = -1` on Traefik, Caddy's
  `reverse_proxy` streams by default).
- **The proxy's idle timeout is too short.** Streams are idle between changes,
  with only a `ping` every 15 seconds. Give the UI route a read/idle timeout
  well above that, 60 seconds or more.
- **The management API is down or unreachable.** The BFF answers `503` when it
  can't reach jack. Check `docker compose ps` and the backend logs for
  `Management API listening`.

## Seeing what jack is doing

Set `LOG_LEVEL=trace` to log every HTTP request (method, path, status,
duration). Registration failures always log the raw *arr response body at
`error` level. That body carries the real validation message and usually tells
you exactly what *arr is unhappy about.
