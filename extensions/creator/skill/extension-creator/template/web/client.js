/**
 * my-extension's browser half: plain JavaScript, loaded as it is, in every page signed in to the portal. It draws a
 * call of its tool in the conversation, and a page in the sidebar that asks its server half's route. Components are
 * made with the portal's own React, without JSX, so nothing here needs building.
 */
export default function (portal) {
  const { React, ui } = portal;
  const { useEffect, useState } = React;
  const h = React.createElement;

  /** A call of my_extension_echo, in place of the portal's card for it once it is done. */
  function EchoCall({ call, card }) {
    // While it runs, and when it failed, the portal's own card says it best.
    if (call.status !== "done") return card;
    return h("div", { className: "my-extension-call" }, h("span", null, "Echo"), h("p", null, String(call.input.text ?? "")));
  }

  /** A page of its own, at /x/my-extension/hello: what its server half answers. */
  function HelloPage() {
    const [hello, setHello] = useState(null);
    const [error, setError] = useState(null);
    useEffect(() => {
      portal.api.json(portal.api.url("/hello")).then(setHello, setError);
    }, []);
    return h(
      "div",
      { className: "my-extension-page" },
      error ? h(ui.LoadFailed, { error, onRetry: () => location.reload() }) : h("p", null, hello ? `Hello, ${hello.hello}` : "…"),
    );
  }

  portal.slots.register("chat.tool", { id: "echo", tool: "my_extension_echo", component: EchoCall });
  portal.slots.register("nav.page", { id: "hello", title: "My extension", component: HelloPage });
}
