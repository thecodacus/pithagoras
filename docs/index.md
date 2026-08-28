---
layout: home

hero:
  image:
    src: /logo.png
    alt: Pithagoras
  name: Pithagoras
  text: A web portal for the pi coding agent
  tagline: Give it a task, close the browser, come back later and find it finished.
  actions:
    - theme: brand
      text: What is Pithagoras
      link: /guide/what-is-pithagoras
    - theme: alt
      text: Deploy it
      link: /guide/deploying
    - theme: alt
      text: Write a channel
      link: /channels/writing-a-channel

features:
  - title: Runs on the server, not the tab
    details: A prompt is accepted and then owned by the server. Every event pi emits is appended to a log, so a browser that reconnects days later replays what it missed instead of having lost the run.
  - title: One workspace per session
    details: Sessions are created against a workspace directory and keep their own model, effort level and conversation. Pinned ones stay at the top of the sidebar.
  - title: Pluggable channels
    details: Reach the agent from Telegram, Slack, Discord, a webhook, or anything you write yourself. Channel types are packages, installable from a GitHub repo.
  - title: pi's own extensions
    details: Packages installed through pi contribute their slash commands to the portal, dialogs and all — /models opens the same menu the TUI draws.
---
