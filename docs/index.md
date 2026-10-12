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
  - title: Agents, Home and projects
    details: New starts a chat with the agent picked for new chats (Home, the first agent's directory, by default), and more agents can have a character and memory of their own. Projects are folders of their own with instructions for the agent, as an AGENTS.md. Each session keeps its own model, effort level and conversation, and pinned ones stay at the top of the sidebar.
  - title: Pluggable channels
    details: Reach the agent from Telegram, Slack, Discord, Signal, a webhook, or anything you write yourself. Channel types are packages, installable from a GitHub repo.
  - title: pi's own extensions
    details: Packages installed through pi contribute their slash commands to the portal, dialogs and all — a command that asks a question opens the same menu the TUI draws.
  - title: A base prompt under 4k tokens
    details: A fresh agent session starts at roughly 3.8k tokens — the agent's identity and memory, its tools, and a listing of installed skills. Skill bodies load when used, not before, so the window you paid for is mostly still yours.
---
