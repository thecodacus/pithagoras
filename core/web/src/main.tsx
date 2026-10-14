import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { registerServiceWorker } from "./register-sw";
// Before the app: its first frame is already in the language chosen.
import { ready } from "./locales";
import App from "./App";
import "./styles";
import { installTooltips } from "./tooltips";
import { watchKeyboard } from "./keyboard";
import { installMotion } from "./motion";
import { Intro } from "./components/Intro";

installTooltips();
watchKeyboard();
// Before the first draw: the intro and every other animation read what it says.
installMotion();

// In the language chosen: for German that is a file to fetch first, which is soon there.
void ready.then(() =>
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
      <Intro />
    </React.StrictMode>
  ),
);

registerServiceWorker(import.meta.env.PROD);
