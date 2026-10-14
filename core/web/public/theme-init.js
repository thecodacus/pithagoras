(function () {
        try {
          var t = localStorage.getItem("pithagoras.theme") || "system";
          var dark =
            t === "dark" ||
            (t === "system" && !matchMedia("(prefers-color-scheme: light)").matches);
          document.documentElement.dataset.theme = dark ? "dark" : "light";
          // The installed app's title bar, in --canvas from index.css. The tag
          // starts out dark.
          var meta = document.querySelector('meta[name="theme-color"]');
          if (meta && !dark) meta.content = "#fafafb";
          var bar = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
          if (bar && !dark) bar.content = "default";
          // A theme an extension brought, as it was when chosen (see theme.tsx): painted now,
          // before the app and long before any extension is loaded.
          var palette = JSON.parse(localStorage.getItem("pithagoras.palette") || "null");
          var colours = (palette && palette[dark ? "dark" : "light"]) || {};
          for (var token in colours) {
            if (/^[a-z-]+$/.test(token) && /^\d{1,3} \d{1,3} \d{1,3}$/.test(colours[token])) document.documentElement.style.setProperty("--" + token, colours[token]);
          }
          if (meta && /^\d{1,3} \d{1,3} \d{1,3}$/.test(colours.canvas)) meta.content = "rgb(" + colours.canvas.split(" ").join(", ") + ")";
        } catch (e) {
          document.documentElement.dataset.theme = "dark";
        }
      })();
