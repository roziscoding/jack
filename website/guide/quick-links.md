---
description: Share a jack instance with a friend by generating a single quick link that carries the peer URL, a freshly issued API key, and any proxy headers needed to reach you.
---

# Quick links

Peering by hand means copying three things into your friend's config: your peer
URL, an API key you issued them, and — if you sit behind an authenticating proxy
— whatever headers that proxy demands. A **quick link** bundles all of it into
one string you paste into a chat window:

```
jack-link:v1:eyJ2IjoxLCJ0eXBlIjoicGVlciIsIm5hbWUiOiJSb3rigJlzIEphY2siLCJ1cmwiOi…
```

The friend pastes it into their management UI, reviews the decoded fields, and
saves the peer. No key typed by hand, no URL typo, no forgotten header.

::: danger A quick link is a credential
The link **contains a working API key in plain text**. Anyone who gets it can
search and download from your libraries until you revoke the key. Send it over
a channel you trust and never paste one into a public issue, gist, or forum.
:::

## Set up quick linking

Generating links needs one thing configured first: how another jack reaches
*this* instance. That lives in the `jack.external` block, editable from
**Settings → Quick linking** in the [management UI](/guide/management-ui):

- **Instance name** — the peer name suggested to whoever imports your link
  (they can change it before saving).
- **External URL** — the URL a peer should use to reach you, e.g.
  `https://jack.example.com`. This is *not* [`jack.internalUrl`](/reference/configuration#jack-internalurl),
  which is the address your own Radarr/Sonarr use. HTTP and HTTPS only, and no
  `user:password@` credentials embedded in the URL.
- **External headers** — optional headers a peer must send to get through your
  proxy, such as Cloudflare Access service tokens. Each value is a
  [`ConfigSecret`](/reference/configuration#configsecret), so prefer an `env` or
  `file` reference over a literal.

Save it once; the profile is reused for every link you generate. See
[`jack.external`](/reference/configuration#jack-external) for the full schema.

::: tip Use HTTPS
The API key in a quick link — and in every request the peer later makes — is
carried in a header. An `http://` external URL exposes it to anything on the
path, and jack warns at startup about peers configured over plain HTTP.
:::

## Generate a link

**Settings → Quick linking → Generate quick link** asks for:

- **Suggested peer name** — how you'll show up in your friend's peer list,
  prefilled from your instance name.
- **Key name** and an optional **description** — how *you'll* identify this
  credential later, so you know which link to revoke.

On submit, jack resolves your external profile, **issues a brand-new peer API
key**, and returns the encoded link.

The plaintext link is shown **once**, in that dialog. Close it and the key is
gone from the UI — the same one-time reveal as any other
[peer API key](/guide/peering). Copy it before you close, and generate a fresh
link if you lose it.

::: tip One link per friend
Every generated link carries its own key, so revoking one friend's access —
**Settings → API keys**, find the key by the name you gave it, revoke — leaves
everyone else connected. Never reuse one link for two people.
:::

## Import a link

On the receiving side: **Settings → Quick linking → Add via quick link**, paste,
and hit **Review peer**. jack decodes the link and opens the normal *Add peer*
form with the name, URL, key, and headers filled in. Nothing is saved until you
review the fields and submit, so you can rename the peer or check where the URL
actually points first.

A link that fails to decode is rejected outright — bad prefix, corrupt payload,
a non-HTTP URL, or a header the format doesn't allow. jack won't half-import it.

## Revoking access

A quick link is only as live as the key inside it. Revoke that key in
**Settings → API keys** and the link stops working immediately, for whoever
holds it. That's the whole reason each link gets its own key: the name and
description you set at generation time are how you find the right one later.

Removing the `jack.external` block (**Remove configuration** in the Quick
linking section) only stops you from generating *new* links — links already out
there keep working until their keys are revoked.

## What's inside a link

A quick link is the prefix `jack-link:v1:` followed by a base64url-encoded JSON
object:

```json
{
  "v": 1,
  "type": "peer",
  "name": "Roz’s Jack",
  "url": "https://jack.example.com",
  "apiKey": "<the freshly issued peer API key>",
  "headers": { "CF-Access-Client-Id": "…" }
}
```

It is **encoded, not encrypted** — anyone can decode it, which is exactly why
it's treated as a secret. Decoding is strict: the version and type must match,
the URL must be `http`/`https` without embedded credentials, and header names
are validated against the same rules the config uses (no `X-Api-Key`, no `Host`,
no duplicates, no line breaks).

Programmatically, `POST /quick-links` on the
[management API](/reference/management-api) does the same thing as the button —
resolve the profile, mint a key, return the link once. If the external profile
is missing or one of its secret references can't be resolved, the request fails
**before** a key is issued, so a broken profile never leaves an orphaned
credential behind.
