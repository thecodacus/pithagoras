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
          // A theme an extension brought, as it was when chosen (see theme.tsx): painted now, before the app and long
          // before any extension is loaded. It is checked as the app checks it (storedPalette in theme.tsx, tokens.ts),
          // written out again here because this is a plain script: the same themes pass, and one with anything in it
          // that is not a theme's is not painted at all, its colours with it.
          var own = function (map, key) { return Object.prototype.hasOwnProperty.call(map, key); };
          var isMap = function (given) { return !!given && typeof given === "object" && !Array.isArray(given); };
          var triplet = function (value) {
            if (typeof value !== "string") return null;
            var text = value.trim(), hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
            if (/^\d{1,3} \d{1,3} \d{1,3}$/.test(text)) return text.split(" ").every(function (n) { return Number(n) <= 255; }) ? text : null;
            if (!hex) return null;
            var full = hex[1].length === 3 ? hex[1].replace(/./g, "$&$&") : hex[1];
            return [0, 2, 4].map(function (at) { return parseInt(full.slice(at, at + 2), 16); }).join(" ");
          };
          var colourNames = { canvas: 1, surface: 1, raised: 1, line: 1, fg: 1, "fg-muted": 1, "fg-subtle": 1, "fg-faint": 1, accent: 1, "accent-fg": 1, ok: 1, warn: 1, danger: 1, terminal: 1, "terminal-fg": 1 };
          var coloursOf = function (given) {
            if (given === undefined) return {};
            if (!isMap(given)) return null;
            var out = {};
            for (var name in given) {
              if (!own(given, name)) continue;
              var colour = own(colourNames, name) && triplet(given[name]);
              if (!colour) return null;
              out[name] = colour;
            }
            return out;
          };
          var fontName = /^(?:"[\p{L}\p{N}_ '.-]{1,100}"|'[\p{L}\p{N}_ ".-]{1,100}'|-?[\p{L}_][\p{L}\p{N}_-]*(?: +-?[\p{L}_][\p{L}\p{N}_-]*)*)$/u;
          var shadowOne = /^(?:inset\s+)?((?:-?\d{1,3}(?:\.\d{1,3})?(?:px|rem)|0)(?:\s+(?:-?\d{1,3}(?:\.\d{1,3})?(?:px|rem)|0)){1,3})(?:\s+(?:rgb\(\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*(?:\/\s*(?:0|1|0?\.\d{1,3})\s*)?\)|#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|transparent))?$/i;
          var bezier = /^cubic-bezier\(\s*(-?\d{0,2}(?:\.\d{1,3})?)\s*,\s*(-?\d{0,2}(?:\.\d{1,3})?)\s*,\s*(-?\d{0,2}(?:\.\d{1,3})?)\s*,\s*(-?\d{0,2}(?:\.\d{1,3})?)\s*\)$/;
          var kinds = {
            font: function (text) { return text.length <= 200 && text.split(",").every(function (name) { return fontName.test(name.trim()); }); },
            shadow: function (text) {
              if (text === "none") return true;
              var shadows = text.split(",");
              return shadows.length <= 4 && shadows.every(function (one) {
                var parts = shadowOne.exec(one.trim());
                return !!parts && parts[1].split(/\s+/).every(function (length) { return Math.abs(parseFloat(length)) / (/px$/.test(length) ? 16 : 1) <= 4; }) &&
                  [parts[2], parts[3], parts[4]].every(function (n) { return n === undefined || Number(n) <= 255; });
              });
            },
            time: function (text) { var time = /^(\d{1,4}(?:\.\d{1,3})?)(ms|s)$/.exec(text); return !!time && Number(time[1]) * (time[2] === "s" ? 1000 : 1) <= 1000; },
            easing: function (text) {
              if (["linear", "ease", "ease-in", "ease-out", "ease-in-out"].indexOf(text) >= 0) return true;
              var curve = bezier.exec(text);
              if (!curve) return false;
              var n = curve.slice(1).map(function (part) { return /\d/.test(part) ? Number(part) : NaN; });
              return n[0] >= 0 && n[0] <= 1 && n[2] >= 0 && n[2] <= 1 && n[1] >= -2 && n[1] <= 3 && n[3] >= -2 && n[3] <= 3;
            },
          };
          var rules = { "font-sans": "font", "font-mono": "font", "text-base": [0.75, 1.5], "radius-sm": [0, 2], "radius-md": [0, 2], "radius-lg": [0, 2], "radius-xl": [0, 2], "radius-2xl": [0, 2], "border-width": [0, 0.25], pad: [0.1, 0.6], gap: [0.1, 0.6], "shadow-sm": "shadow", "shadow-pop": "shadow", "dur-fast": "time", "dur-base": "time", "ease-out": "easing", "ease-spring": "easing", "chat-max": [24, 90], "nav-width": [12, 24] };
          var tokensOf = function (given) {
            if (given === undefined) return {};
            if (!isMap(given)) return null;
            var out = {};
            for (var name in given) {
              if (!own(given, name)) continue;
              var rule = own(rules, name) && rules[name], text = typeof given[name] === "string" && given[name].trim(), ok = false;
              if (typeof rule === "string") ok = text !== false && kinds[rule](text);
              else if (rule && text) {
                var length = /^(\d{1,3}(?:\.\d{1,3})?)(px|rem)$/.exec(text), rem = length && Number(length[1]) / (length[2] === "px" ? 16 : 1);
                ok = !!length && rem >= rule[0] && rem <= rule[1];
              }
              if (!ok) return null;
              out[name] = text;
            }
            return out;
          };
          var palette = null;
          try {
            var kept = JSON.parse(localStorage.getItem("pithagoras.palette") || "null");
            var light = kept && coloursOf(kept.light), darkColours = kept && coloursOf(kept.dark), tokens = kept && tokensOf(kept.tokens);
            if (kept && typeof kept.id === "string" && typeof kept.name === "string" && light && darkColours && tokens) palette = { colours: dark ? darkColours : light, tokens: tokens };
          } catch (e) {} // Not a theme: the portal's own.
          var colours = palette ? palette.colours : {};
          for (var token in colours) document.documentElement.style.setProperty("--" + token, colours[token]);
          if (meta && colours.canvas) meta.content = "rgb(" + colours.canvas.split(" ").join(", ") + ")";
          // The theme's look beyond colour, then the person's text size and density over it.
          try {
          var looks = palette ? palette.tokens : {};
          if (looks["font-mono"]) looks["font-mono-chat"] = looks["font-mono"];
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
