import { defineConfig } from "vitepress";

// Project pages serve from /<repo>/, so every asset and link needs the
// prefix, spelled as the repository is: the paths are case-sensitive. The
// docs workflow sets it from the repository's name; this is the upstream's for
// a build by hand. Overridable for a custom domain, where the site is at the root.
const base = (process.env.DOCS_BASE ?? "/pithagoras/").replace(/\/?$/, "/");

export default defineConfig({
  title: "Pithagoras",
  base,
  description: "A hosted web portal for the pi coding agent",
  lastUpdated: true,
  cleanUrls: true,

  head: [["link", { rel: "icon", type: "image/png", href: `${base}favicon.png` }]],

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
          { text: "Upgrading", link: "/guide/upgrading" },
          { text: "Sessions", link: "/guide/sessions" },
          { text: "Projects", link: "/guide/projects" },
          { text: "Agents", link: "/guide/agents" },
          { text: "Slash commands", link: "/guide/commands" },
          { text: "Routines", link: "/guide/routines" },
          { text: "The interface", link: "/guide/interface" },
          { text: "Settings", link: "/guide/settings" },
          { text: "Models and providers", link: "/guide/models" },
          { text: "Extensions", link: "/guide/extensions" },
          { text: "Skills", link: "/guide/skills" },
          { text: "Prompt injection", link: "/guide/security" },
          { text: "Sandbox", link: "/guide/sandbox" },
          { text: "MCP servers", link: "/guide/mcp" },
          { text: "The agent's browser", link: "/guide/browser" },
          { text: "Docker add-ons", link: "/guide/add-ons" },
          { text: "Opt-in features", link: "/guide/features" },
          { text: "Voice control", link: "/guide/voice" },
          { text: "Voice latency profiling", link: "/guide/voice-profiling" },
          { text: "Voice pipeline switches", link: "/guide/voice-comparison" },
          { text: "Session canvases", link: "/guide/canvases" },
          { text: "Files", link: "/guide/files" },
          { text: "Git", link: "/guide/git" },
          { text: "Terminal and background jobs", link: "/guide/terminal" },
          { text: "Memory and audit", link: "/guide/memory" },
          { text: "Images", link: "/guide/images" },
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
