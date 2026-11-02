/* Preview data only. No real thread metadata or provider state is changed. */
(() => {
  const states = ["Present", "Needs you", "Later", "Done"];
  const storageKey = "bigbud.inyosira-sidebar-preview.v1";
  const samples = [
    ["inyosira", "Build Inyosira mode", "claude", "local", "bigbud", "Present", "Working", "2m"],
    [
      "tiles",
      "Optimise tile caching",
      "codex",
      "local",
      "map-tile-hub",
      "Present",
      "Working",
      "8m",
    ],
    [
      "deploy",
      "Check deployment logs",
      "opencode",
      "server",
      "production-vps",
      "Present",
      "",
      "12m",
    ],
    ["writing", "Polish the document editor", "claude", "local", "wordsmith", "Later", "", "1h"],
    ["links", "Custom domains for short links", "codex", "server", "shwty-vps", "Later", "", "3h"],
    ["weekend", "Ideas for the weekend", "pi", "chat", "Chat", "Later", "", "1d"],
    [
      "approval",
      "Review the release plan",
      "claude",
      "local",
      "bigbud",
      "Needs you",
      "Plan Ready",
      "5m",
    ],
    [
      "input",
      "Choose the deployment region",
      "codex",
      "server",
      "production-vps",
      "Needs you",
      "Awaiting Input",
      "18m",
    ],
    ["browser", "Browser search suggestions", "codex", "local", "bigbud", "Done", "Done", "2h"],
    ["citations", "Exact-text citations", "claude", "local", "bigbud", "Done", "Done", "4h"],
    ["dinner", "A little dinner inspiration", "pi", "chat", "Chat", "Done", "Done", "1d"],
  ];
  const threads = samples.map(([id, title, provider, location, project, state, status, time]) => ({
    id,
    title,
    provider,
    location,
    project,
    state,
    status,
    time,
  }));
  let mode = "inyosira";
  let selectedId = "inyosira";
  let collapsed = [];
  let theme = "dark";
  let draggedId = null;
  let toastTimeout;
  let menuTrigger;
  const groups = document.querySelector("#thread-groups");
  const menu = document.querySelector("#thread-menu");
  const search = document.querySelector("#search");
  const moveSelect = document.querySelector("#move-state");
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved && typeof saved === "object") {
      for (const thread of threads) {
        if (states.includes(saved.states?.[thread.id])) thread.state = saved.states[thread.id];
      }
      if (["inyosira", "projects"].includes(saved.mode)) mode = saved.mode;
      if (threads.some((thread) => thread.id === saved.selectedId)) selectedId = saved.selectedId;
      if (Array.isArray(saved.collapsed))
        collapsed = saved.collapsed.filter((key) => typeof key === "string");
      if (["dark", "light"].includes(saved.theme)) theme = saved.theme;
    }
  } catch {
    /* Storage may be unavailable when opened directly from disk. */
  }

  function save() {
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          states: Object.fromEntries(threads.map((thread) => [thread.id, thread.state])),
          mode,
          selectedId,
          collapsed,
          theme,
        }),
      );
    } catch {
      notify("Browser storage is unavailable; changes will last for this visit only.");
    }
  }
  function notify(message) {
    const toast = document.querySelector("#toast");
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toast.hidden = true;
    }, 3200);
  }
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }
  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#icon-${name}`);
    svg.append(use);
    return svg;
  }
  function closeMenu(restoreFocus = false) {
    menu.hidden = true;
    if (restoreFocus) menuTrigger?.focus();
  }
  function moveThread(id, state) {
    const thread = threads.find((item) => item.id === id);
    if (!thread || !states.includes(state)) return false;
    thread.state = state;
    collapsed = collapsed.filter((key) => key !== `inyosira:${state}`);
    closeMenu();
    save();
    render();
    document.querySelector("#announcement").textContent = `${thread.title} moved to ${state}.`;
    notify(`Moved to ${state}`);
    return true;
  }
  function openMenu(event, thread, row) {
    event.preventDefault();
    menuTrigger = row;
    menu.replaceChildren(element("div", "menu-label", "Move to"));
    for (const state of states) {
      const button = element("button", "", state);
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.disabled = thread.state === state;
      button.addEventListener("click", () => {
        moveThread(thread.id, state);
        document.querySelector(`[data-thread-id="${thread.id}"]`)?.focus();
      });
      menu.append(button);
    }
    const bounds = row.getBoundingClientRect();
    const x = event.clientX || bounds.left + 20;
    const y = event.clientY || bounds.bottom;
    menu.hidden = false;
    menu.style.left = `${Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8))}px`;
    menu.querySelector("button:not(:disabled)")?.focus();
  }
  function threadRow(thread) {
    const row = element("button", "thread-row");
    row.type = "button";
    row.draggable = true;
    row.dataset.threadId = thread.id;
    row.setAttribute("aria-current", thread.id === selectedId ? "page" : "false");
    row.setAttribute("aria-haspopup", "menu");
    row.title = `${thread.title}\n${thread.project}\nRight-click to move`;
    const top = element("span", "thread-top");
    const tone =
      thread.status === "Working"
        ? "working"
        : thread.status === "Awaiting Input"
          ? "warning"
          : thread.status === "Done"
            ? "complete"
            : "";
    const provider = element("span", `provider ${tone}`);
    provider.setAttribute("role", "img");
    provider.setAttribute("aria-label", thread.provider);
    const providerImage = element("span", "provider-image");
    providerImage.style.setProperty(
      "--provider-image",
      `url("../../apps/marketing/public/provider-icons/${thread.provider}.svg")`,
    );
    provider.append(providerImage);
    top.append(provider, element("span", "thread-title", thread.title));
    if (thread.status) {
      const status = element("span", `thread-status ${tone}`);
      if (thread.status !== "Done") status.append(element("span", "status-dot"));
      status.append(document.createTextNode(thread.status));
      top.append(status);
    }
    top.append(element("span", "thread-time", thread.time));
    row.append(top);
    if (mode === "inyosira") {
      const location = element("span", "thread-location");
      location.append(
        icon(
          thread.location === "local"
            ? "monitor"
            : thread.location === "server"
              ? "server"
              : "chat",
        ),
        element("span", "", thread.project),
      );
      row.append(location);
    }
    row.addEventListener("click", () => {
      selectedId = thread.id;
      save();
      render();
    });
    row.addEventListener("contextmenu", (event) => openMenu(event, thread, row));
    row.addEventListener("keydown", (event) => {
      if (event.key === "F10" && event.shiftKey) openMenu(event, thread, row);
    });
    row.addEventListener("dragstart", (event) => {
      draggedId = thread.id;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", thread.id);
      row.classList.add("dragging");
      closeMenu();
    });
    row.addEventListener("dragend", () => {
      draggedId = null;
      row.classList.remove("dragging");
      groups
        .querySelectorAll(".drop-target")
        .forEach((node) => node.classList.remove("drop-target"));
    });
    return row;
  }
  function render() {
    const focusedId = document.activeElement?.dataset.threadId;
    document.documentElement.classList.toggle("dark", theme === "dark");
    groups.classList.toggle("projects-mode", mode === "projects");
    document
      .querySelectorAll("[data-mode]")
      .forEach((button) =>
        button.setAttribute("aria-pressed", String(button.dataset.mode === mode)),
      );
    groups.replaceChildren();
    const query = search.value.trim().toLocaleLowerCase();
    const visible = threads.filter((thread) =>
      `${thread.title} ${thread.project} ${thread.provider}`.toLocaleLowerCase().includes(query),
    );
    const groupNames =
      mode === "inyosira" ? states : [...new Set(threads.map((thread) => thread.project))];
    for (const name of groupNames) {
      const members = visible.filter(
        (thread) => (mode === "inyosira" ? thread.state : thread.project) === name,
      );
      if (mode === "projects" && !members.length) continue;
      const key = `${mode}:${name}`;
      const section = element("section", "thread-group");
      section.dataset.group = name;
      const heading = element("button", "group-heading");
      heading.type = "button";
      const isExpanded = Boolean(query) || !collapsed.includes(key);
      heading.setAttribute("aria-expanded", String(isExpanded));
      heading.append(
        element("span", "", name),
        element("span", "group-count", String(members.length)),
      );
      heading.addEventListener("click", () => {
        collapsed = collapsed.includes(key)
          ? collapsed.filter((item) => item !== key)
          : [...collapsed, key];
        save();
        render();
        groups.querySelector(`[data-group="${name}"] .group-heading`)?.focus();
      });
      section.append(heading);
      if (isExpanded) {
        const list = element("div", "thread-list");
        list.append(...members.map(threadRow));
        if (!members.length)
          list.append(
            element("p", "empty-group", query ? "No matching threads" : "No threads here"),
          );
        section.append(list);
      }
      if (mode === "inyosira") {
        section.addEventListener("dragover", (event) => {
          if (!draggedId) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          section.classList.add("drop-target");
        });
        section.addEventListener("dragleave", (event) => {
          if (!section.contains(event.relatedTarget)) section.classList.remove("drop-target");
        });
        section.addEventListener("drop", (event) => {
          event.preventDefault();
          section.classList.remove("drop-target");
          if (draggedId) moveThread(draggedId, name);
          draggedId = null;
        });
      }
      groups.append(section);
    }
    const active = threads.find((thread) => thread.id === selectedId);
    document.querySelector("#active-title").textContent = active.title;
    document.querySelector("#active-location").textContent = active.project;
    moveSelect.value = active.state;
    if (focusedId) groups.querySelector(`[data-thread-id="${focusedId}"]`)?.focus();
  }
  document.querySelectorAll("[data-mode]").forEach((button) =>
    button.addEventListener("click", () => {
      mode = button.dataset.mode;
      closeMenu();
      save();
      render();
    }),
  );
  search.addEventListener("input", render);
  moveSelect.addEventListener("change", () => moveThread(selectedId, moveSelect.value));
  document.querySelector("#theme-toggle").addEventListener("click", () => {
    theme = theme === "dark" ? "light" : "dark";
    save();
    render();
  });
  document
    .querySelector("#new-chat")
    .addEventListener("click", () =>
      notify("This is a layout preview; no real chat will be created."),
    );
  document.addEventListener("pointerdown", (event) => {
    if (!menu.contains(event.target)) closeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu(true);
    if (!menu.hidden && ["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      const options = [...menu.querySelectorAll("button:not(:disabled)")];
      const offset = event.key === "ArrowDown" ? 1 : -1;
      options[
        (options.indexOf(document.activeElement) + offset + options.length) % options.length
      ]?.focus();
    }
  });
  groups.addEventListener("scroll", () => closeMenu(), { passive: true });
  window.addEventListener("resize", () => closeMenu());
  // Demonstrates a shared movement path; this is not an agent integration.
  window.inyosiraPreview = Object.freeze({ moveThread });
  render();
})();
