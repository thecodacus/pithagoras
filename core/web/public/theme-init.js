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
          // The look beyond colour (src/tokens.ts, which this repeats: the same values pass, the same are refused): the
          // theme's own, then the person's text size and density over it. A theme that has a value that is not one is not painted at all.
          try {
          var rules = { "font-sans": "font", "font-mono": "font", "text-base": [0.75, 1.5], "radius-sm": [0, 2], "radius-md": [0, 2], "radius-lg": [0, 2], "radius-xl": [0, 2], "radius-2xl": [0, 2], pad: [0.1, 0.6], gap: [0.1, 0.6], "chat-max": [24, 90], "nav-width": [12, 24] };
          var looks = {};
          var given = palette && palette.tokens;
          if (given && typeof given === "object" && !Array.isArray(given)) {
            for (var name in given) {
              var rule = Object.prototype.hasOwnProperty.call(rules, name) && rules[name], text = typeof given[name] === "string" && given[name].trim(), ok = false;
              if (rule === "font") ok = /^[\p{L}\p{N}_ "',.-]{1,200}$/u.test(text);
              else if (rule && text) {
                var length = /^(\d{1,3}(?:\.\d{1,3})?)(px|rem)$/.exec(text), rem = length && Number(length[1]) / (length[2] === "px" ? 16 : 1);
                ok = !!length && rem >= rule[0] && rem <= rule[1];
              }
              if (!ok) { looks = {}; break; }
              looks[name] = text;
            }
          }
          var mine = JSON.parse(localStorage.getItem("pithagoras.appearance") || "null") || {};
          var percent = function (value, least, most) { return typeof value === "number" && value % 1 === 0 && value >= least && value <= most ? value : 100; };
          var scale = function (name, stock, by) { if (by !== 100) looks[name] = "calc(" + (looks[name] || stock) + " * " + by / 100 + ")"; };
          scale("text-base", "1rem", percent(mine.text, 80, 140));
          scale("pad", "0.25rem", percent(mine.density, 70, 140));
          scale("gap", "0.25rem", percent(mine.density, 70, 140));
          for (var look in looks) document.documentElement.style.setProperty("--" + look, looks[look]);
          } catch (e) {} // What is wrong here must not take the theme's colours with it.
        } catch (e) {
          document.documentElement.dataset.theme = "dark";
        }
      })();
