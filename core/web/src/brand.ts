/**
 * What the portal is called and drawn as, in one place: the sign-in page, the sidebar, the phone's top bar, the tab's
 * title and a notification all read it from here. (`index.html` and `public/manifest.webmanifest` hold the same name,
 * which a page cannot read from a module before it has loaded; `tests/brand.test.mts` keeps them the same.)
 */
export const brand = {
  name: "Pithagoras",
  /** The picture beside the name: a square, in the page's public folder. */
  icon: "/icon-192.png",
} as const;
