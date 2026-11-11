/* Google Places city suggestions with a local fallback; free text remains supported. */
(() => {
  let sequence = 0;
  window.TriplingLocations = {
    init(root = document) {
      root.querySelectorAll("input[data-location]").forEach((input) => {
        if (input.dataset.comboboxReady) return;
        input.dataset.comboboxReady = "true";
        const wrap = document.createElement("span");
        wrap.className = "location-combobox";
        input.parentNode.insertBefore(wrap, input);
        wrap.append(input);
        const list = document.createElement("span");
        list.className = "location-options";
        list.id = "location-options-" + ++sequence;
        list.setAttribute("role", "listbox");
        list.hidden = true;
        wrap.append(list);
        const feedback = document.createElement("span");
        feedback.className = "location-feedback";
        feedback.id = list.id + "-feedback";
        feedback.setAttribute("role", "status");
        wrap.append(feedback);
        input.setAttribute("aria-describedby", feedback.id);
        input.setAttribute("role", "combobox");
        input.setAttribute("aria-autocomplete", "list");
        input.setAttribute("aria-expanded", "false");
        input.setAttribute("aria-controls", list.id);
        input.autocomplete = "off";
        let timer,
          version = 0,
          index = -1,
          values = [];
        const close = () => {
          list.hidden = true;
          input.setAttribute("aria-expanded", "false");
          input.removeAttribute("aria-activedescendant");
          index = -1;
        };
        const select = (i) => {
          version++;
          clearTimeout(timer);
          if (values[i] !== undefined) {
            input.value = values[i].value;
            input.dispatchEvent(new Event("change", { bubbles: true }));
          }
          close();
        };
        const load = async () => {
          clearTimeout(timer);
          const current = ++version,
            q = input.value;
          try {
            const result = await TriplingAuth.api(
              "/locations?q=" + encodeURIComponent(q),
            );
            if (
              current !== version ||
              document.activeElement !== input ||
              q !== input.value
            )
              return;
            values =
              result.suggestions ||
              result.locations.map((value) => ({ value, label: value }));
            feedback.textContent =
              result.message ||
              (q.length >= 2 && !values.length
                ? "No matching cities. You can type your city."
                : "");
            index = -1;
            list.replaceChildren();
            values.forEach((value, i) => {
              const option = document.createElement("span");
              option.textContent = value.label;
              option.id = list.id + "-" + i;
              option.setAttribute("role", "option");
              option.setAttribute("aria-selected", "false");
              option.addEventListener("mousedown", (e) => {
                e.preventDefault();
                select(i);
              });
              list.append(option);
            });
            if (result.provider === "google" && values.length) {
              const attribution = document.createElement("span");
              attribution.className = "places-attribution";
              const logo = document.createElement("img");
              logo.src = "/assets/powered-by-google.png";
              logo.alt = "Powered by Google";
              logo.width = 120;
              logo.height = 14;
              attribution.append(logo);
              list.append(attribution);
            }
            list.hidden = !values.length;
            input.setAttribute("aria-expanded", String(!!values.length));
          } catch {
            if (
              current !== version ||
              q !== input.value ||
              document.activeElement !== input
            )
              return;
            feedback.textContent =
              "Suggestions unavailable. You can still type your city.";
            close();
          }
        };
        input.addEventListener("input", () => {
          version++;
          clearTimeout(timer);
          close();
          feedback.textContent = "";
          timer = setTimeout(load, 350);
        });
        input.addEventListener("focus", load);
        input.addEventListener("blur", close);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Escape") {
            version++;
            clearTimeout(timer);
            close();
            return;
          }
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (list.hidden) {
              load();
              return;
            }
            index =
              (index + (e.key === "ArrowDown" ? 1 : -1) + values.length) %
              values.length;
            [...list.querySelectorAll('[role="option"]')].forEach((el, i) =>
              el.setAttribute("aria-selected", String(i === index)),
            );
            input.setAttribute(
              "aria-activedescendant",
              list.children[index].id,
            );
            list.children[index].scrollIntoView({ block: "nearest" });
          } else if (e.key === "Enter" && !list.hidden && index >= 0) {
            e.preventDefault();
            select(index);
          }
        });
      });
    },
  };
})();
