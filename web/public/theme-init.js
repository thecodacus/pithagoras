(function () {
        try {
          var t = localStorage.getItem("pithagoras.theme") || "system";
          var dark =
            t === "dark" ||
            (t === "system" && !matchMedia("(prefers-color-scheme: light)").matches);
          document.documentElement.dataset.theme = dark ? "dark" : "light";
        } catch (e) {
          document.documentElement.dataset.theme = "dark";
        }
      })();
