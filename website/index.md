---
layout: home
title: Private media sharing for Radarr and Sonarr
description: Share Radarr and Sonarr libraries directly with friends through a private, self-hosted peer-to-peer bridge without public trackers or a BitTorrent swarm.

hero:
  name: jack
  text: Share media libraries through the *arr stack you already run
  tagline: Point Radarr/Sonarr at jack, search like any indexer, and pull media straight from your friends' servers, with no public trackers and no BitTorrent swarm.
  image:
    light: /logo-light.svg
    dark: /logo-dark.svg
    alt: jack peer-to-peer media sharing logo
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: What is jack?
      link: /guide/what-is-jack
    - theme: alt
      text: GitHub
      link: https://github.com/roziscoding/jack

features:
  - icon: 🔍
    title: Looks like a normal indexer
    details: jack registers itself in Radarr/Sonarr as an indexer and download client, with no special setup on their side.
  - icon: 🤝
    title: Private peer-to-peer bridge
    details: Search your friends' libraries and pull files straight from their servers into yours.
  - icon: 🚫
    title: No BitTorrent involved
    details: Files transfer over plain, authenticated HTTP, with no tracker and no swarm.
  - icon: 🖥️
    title: Web management console
    details: Manage servers, peers, API keys, and downloads without hand-editing config files. Transfers and connector state update live.
---
