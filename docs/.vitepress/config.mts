import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Pithagoras",
  // Project pages serve from /<repo>/, so every asset and link needs the
  // prefix. Overridable for a custom domain, where the site is at the root.
  base: process.env.DOCS_BASE ?? "/pithagoras/",
  description: "A hosted web portal for the pi coding agent",
  lastUpdated: true,
  cleanUrls: true,

  head: [["link", { rel: "icon", type: "image/png", href: "/pithagoras/favicon.png" }]],

  themeConfig: {
    logo: "/logo.png",
    nav: [
      { text: "Guide", link: "/guide/what-is-pithagoras" },
      { text: "People", link: "/people/" },
      { text: "Channels", link: "/channels/" },
      { text: "Reference", link: "/reference/api" },
    ],

    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "What is Pithagoras", link: "/guide/what-is-pithagoras" },
          { text: "Deploying", link: "/guide/deploying" },
          { text: "Sessions", link: "/guide/sessions" },
          { text: "Slash commands", link: "/guide/commands" },
          { text: "Routines", link: "/guide/routines" },
          { text: "Settings", link: "/guide/settings" },
          { text: "Extensions", link: "/guide/extensions" },
          { text: "Prompt injection", link: "/guide/security" },
          { text: "MCP servers", link: "/guide/mcp" },
        ],
      },
      {
        text: "People",
        items: [
          { text: "Overview", link: "/people/" },
          { text: "Roles", link: "/people/roles" },
          { text: "Approvals", link: "/people/approvals" },
          { text: "Allowed anyway", link: "/people/rules" },
          { text: "Group chats", link: "/people/groups" },
          { text: "Trust and its limits", link: "/people/trust" },
        ],
      },
      {
        text: "The agent",
        items: [
          { text: "Agent and channels", link: "/channels/" },
          { text: "Writing a channel", link: "/channels/writing-a-channel" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "HTTP API", link: "/reference/api" },
          { text: "Configuration", link: "/reference/configuration" },
          { text: "Architecture", link: "/reference/architecture" },
        ],
      },
    ],

    socialLinks: [{ icon: "github", link: "https://github.com/thecodacus/pithagoras" }],

    search: { provider: "local" },

    footer: {
      message: "Give it a task, close the browser, come back later.",
      copyright: "Pithagoras",
    },
  },
});
