/**
 * my-extension's server half: loaded once for all chats, in a process of its own. Its tools are given to every
 * chat's pi through `portal.chats.extend`, and its routes are at /api/x/my-extension/…, behind the portal's login.
 */
export default function (portal) {
  portal.chats.extend((pi) => {
    pi.registerTool({
      name: "my_extension_echo",
      label: "Echo",
      description: "Says back the text it is given.",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "What to say back" } },
        required: ["text"],
        additionalProperties: false,
      },
      // What the guard holds it to: `outside: true` for a tool that returns what it read from outside (a page, a
      // feed), `acts` for one that changes things ("persist", "publish", "upload"…). This one does neither.
      guard: { outside: false, acts: [] },
      async execute(_id, params) {
        return { content: [{ type: "text", text: params.text }], details: { text: params.text } };
      },
    });
  });

  portal.router.get("/hello", (_req, res) => res.json({ hello: "world" }));

  portal.log("started");
}
