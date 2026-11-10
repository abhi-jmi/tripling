/* Prefix-matched, alphabetically ordered locations; free text remains supported. */
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
          if (values[i] !== undefined) {
            input.value = values[i];
            input.dispatchEvent(new Event("change", { bubbles: true }));
          }
          close();
        };
        const load = async () => {
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
            values = result.locations;
            index = -1;
            list.replaceChildren();
            values.forEach((value, i) => {
              const option = document.createElement("span");
              option.textContent = value;
              option.id = list.id + "-" + i;
              option.setAttribute("role", "option");
              option.setAttribute("aria-selected", "false");
              option.addEventListener("mousedown", (e) => {
                e.preventDefault();
                select(i);
              });
              list.append(option);
            });
            list.hidden = !values.length;
            input.setAttribute("aria-expanded", String(!!values.length));
          } catch {
            close();
          }
        };
        input.addEventListener("input", () => {
          version++;
          clearTimeout(timer);
          close();
          timer = setTimeout(load, 150);
        });
        input.addEventListener("focus", load);
        input.addEventListener("blur", close);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Escape") {
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
            [...list.children].forEach((el, i) =>
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
