---
description: Share a jack instance with a friend by generating a single quick link that carries the peer URL, a freshly issued API key, and any proxy headers needed to reach you.
---

# Quick links

A quick link is one string carrying everything a friend needs to add you as a
peer: your peer URL, an API key issued for them, and any headers your proxy
requires.

```
jack-link:v1:eyJ2IjoxLCJ0eXBlIjoicGVlciIsIm5hbWUiOiJSb3oncyBKYWNrIiwidXJsIjoi...
```

They paste it into their management UI, review the decoded fields, and save the
peer.

::: danger A quick link is a credential
The link **contains a working API key in plain text**. Anyone who gets it can
search and download from your libraries until you revoke the key. Send it over
a channel you trust and never paste one into a public issue, gist, or forum.
:::

## Set up quick linking

Generating links requires a `jack.external` profile, editable under
***Settings -> Quick linking*** in the [management UI](/guide/management-ui):

- **Instance name**: the peer name suggested to whoever imports your link. They
  can change it before saving.
- **External URL**: the URL a peer uses to reach you, e.g.
  `https://jack.example.com`. HTTP and HTTPS only, with no `user:password@`
  credentials embedded.
- **External headers**: optional headers a peer must send to get through your
  proxy, such as Cloudflare Access service tokens. Each value is a
  [`ConfigSecret`](/reference/configuration#configsecret), so prefer an `env` or
  `file` reference over a literal.

Every link you generate reuses the saved profile. Full schema:
[`jack.external`](/reference/configuration#jack-external).

::: tip Use HTTPS
The API key in a quick link, and in every request the peer later makes, travels
in a header. An `http://` external URL exposes it to anything on the path, and
jack warns at startup about peers configured over plain HTTP.
:::

::: warning Internal and external URLs are not the same
[`jack.internalUrl`](/reference/configuration#jack-internalurl) is the address
your own Radarr/Sonarr use to reach jack. Putting it in the external URL hands
peers an address that only resolves on your side.
:::

## Generate a link

***Settings -> Quick linking -> Generate quick link*** asks for:

- **Suggested peer name**: prefilled from your instance name, this is how you
  show up in your friend's peer list.
- **Key name** and an optional **description**: how you identify this credential
  later when you need to revoke it.

On submit, jack resolves the external profile, **issues a new peer API key**,
and returns the encoded link.

The plaintext link appears **once**, in that dialog. Closing it discards the key
from the UI, the same one-time reveal as any other
[peer API key](/guide/peering). Copy it before closing; if you lose it, generate
a fresh link.

::: tip One link per friend
Every generated link carries its own key, so revoking one friend's access leaves
everyone else connected. Never reuse one link for two people.
:::

## Import a link

***Settings -> Quick linking -> Add via quick link*** takes the pasted link and
opens the normal ***Add peer*** form with the name, URL, key, and headers
filled in.
Nothing is saved until you submit, so you can rename the peer or check where
the URL points first.

A link that fails any of the [format checks](#link-format) is rejected outright,
instead of half-filling the form.

## Revoking access

Revoke the key under ***Settings -> API keys*** and the link stops working
immediately. Find it by the name you gave it at generation time.

Removing the `jack.external` block (***Remove configuration*** in the
***Quick linking*** section) only stops you from generating *new* links. Links already out
there keep working until their keys are revoked.

## Link format

The prefix `jack-link:v1:` followed by a base64url-encoded JSON object:

```json
{
  "v": 1,
  "type": "peer",
  "name": "Roz's Jack",
  "url": "https://jack.example.com",
  "apiKey": "<the freshly issued peer API key>",
  "headers": { "CF-Access-Client-Id": "..." }
}
```

There is no encryption. Anyone holding the link can read the key out of it.

Decoding is strict:

- `v` and `type` must match the values above.
- `url` must be `http`/`https`, with no embedded credentials.
- `headers` are validated against the same rules the config uses:
  - reserved names are rejected: `X-Api-Key`, `Host`, `Content-Length`,
    `Connection`, and `Transfer-Encoding`.
  - names must be valid HTTP header tokens.
  - no name may repeat.
  - values must be non-empty.
  - values may not contain line breaks.

To generate a link outside the UI, call
[`POST /quick-links`](/reference/management-api/postQuickLinks) on the
management API. A missing external profile, or one
with a secret reference that cannot be resolved, fails the request before any
key is issued, so a broken profile leaves no orphaned credential.
