import test from "node:test";
import { linksAreFollowed } from "./loaded-from-folders-harness.mjs";

test("a link at a name on the list is followed to what it leads to, for a file that is not there yet, in a conversation's folder, an agent's, and any folder of a project (in capitals)", () => {
  linksAreFollowed([["in capitals", (name) => name.toUpperCase()]]);
});
