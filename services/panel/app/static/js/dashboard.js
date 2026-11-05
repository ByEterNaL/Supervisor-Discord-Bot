/* ═══════════════════════════════════════════════════════════
   NEON GRID HQ — Dashboard Animation Engine
   Uses anime.js v3 for all entrance and interaction animations
   ═══════════════════════════════════════════════════════════ */

/* ── Helpers ── */

function parseJsonAttribute(rawValue, fallback) {
  try {
    return JSON.parse(rawValue || "");
  } catch (_error) {
    return fallback;
  }
}

function initSidebarNavState() {
  const nav = document.querySelector("[data-sidebar-nav]");
  if (!nav || nav.dataset.navStateReady === "1" || typeof sessionStorage === "undefined") {
    return;
  }

  const storageKey = "sidebarNavScrollTop";
  const applyScrollTop = () => {
    const storedValue = Number(sessionStorage.getItem(storageKey) || "0");
    if (!Number.isFinite(storedValue) || storedValue <= 0) {
      return;
    }

    nav.scrollTop = storedValue;
  };

  const restoreScrollTop = () => {
    applyScrollTop();
    requestAnimationFrame(applyScrollTop);
    setTimeout(applyScrollTop, 60);
    setTimeout(applyScrollTop, 180);
  };

  const persistScrollTop = () => {
    sessionStorage.setItem(storageKey, String(nav.scrollTop));
  };

  requestAnimationFrame(restoreScrollTop);
  window.addEventListener("pageshow", restoreScrollTop);
  window.addEventListener("load", restoreScrollTop, { once: true });

  let frameHandle = null;
  nav.addEventListener("scroll", () => {
    if (frameHandle !== null) {
      cancelAnimationFrame(frameHandle);
    }

    frameHandle = requestAnimationFrame(() => {
      persistScrollTop();
      frameHandle = null;
    });
  });

  nav.querySelectorAll("a").forEach((link) => {
    link.addEventListener("pointerdown", persistScrollTop, { capture: true });
    link.addEventListener("click", persistScrollTop, { capture: true });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      persistScrollTop();
    }
  });
  window.addEventListener("beforeunload", persistScrollTop);
  nav.dataset.navStateReady = "1";
}

/* ── Count-up Numbers ── */

function animateCounters(root = document) {
  root.querySelectorAll(".count-up").forEach((element) => {
    if (element.dataset.animated === "1") return;
    element.dataset.animated = "1";

    const target = Number(element.dataset.value || "0");
    const isWholeNumber = Number.isInteger(target);
    const formatValue = (value) => {
      if (!Number.isFinite(value)) {
        return "0";
      }

      if (isWholeNumber) {
        return Math.round(value).toString();
      }

      return Number(value).toFixed(1).replace(/\.0$/, "");
    };

    if (typeof anime === "undefined") {
      element.textContent = formatValue(target);
      return;
    }

    const counter = { value: 0 };
    anime({
      targets: counter,
      value: target,
      duration: 1200,
      easing: "easeOutExpo",
      
      update() {
        element.textContent = formatValue(counter.value);
      }
    });
  });
}

/* ── Bar Fill Animations ── */

function animateBarFills(root = document) {
  root.querySelectorAll("[data-nx-bar]").forEach((bar) => {
    if (bar.dataset.nxReady === "1") return;
    bar.dataset.nxReady = "1";

    const pct = Number(bar.dataset.nxBar || "0");

    if (typeof anime === "undefined" || (typeof sessionStorage !== "undefined" && sessionStorage.getItem("siteAnimated"))) {
      bar.style.width = pct + "%";
      return;
    }

    // Set initial width to 0
    bar.style.width = "0%";

    anime({
      targets: bar,
      width: pct + "%",
      duration: 1200,
      delay: 400,
      easing: "easeOutCubic"
    });
  });
}

/* ── Tile Entrance Animations ── */

function animateTileEntrances(root = document) {
  const tiles = Array.from(root.querySelectorAll("[data-nx='tile']"));

  if (!tiles.length) return;

  if (typeof anime === "undefined" || sessionStorage.getItem("siteAnimated")) {
    tiles.forEach((tile) => {
      tile.style.opacity = "1";
      tile.style.transform = "none";
      tile.dataset.nx = "ready";
    });
    return;
  }

  // Determine entrance direction based on position
  tiles.forEach((tile, index) => {
    tile.style.opacity = "0";

    // Alternate entrance directions for visual variety
    const directions = [
      { translateY: [30, 0], translateX: [0, 0] },
      { translateY: [0, 0], translateX: [-30, 0] },
      { translateY: [20, 0], translateX: [20, 0] },
      { translateY: [0, 0], translateX: [30, 0] },
      { translateY: [-20, 0], translateX: [0, 0] },
    ];

    const direction = directions[index % directions.length];

    anime({
      targets: tile,
      opacity: [0, 1],
      ...direction,
      duration: 300,
      delay: Math.min(index * 20, 150),
      easing: "easeOutCubic",
      complete() {
        tile.dataset.nx = "ready";
        tile.style.transform = "";
      }
    });
  });
}

/* ── Gauge Animations ── */

function animateGauges(root = document) {
  root.querySelectorAll(".nx-gauge__fill").forEach((gauge) => {
    if (gauge.dataset.nxReady === "1") return;
    gauge.dataset.nxReady = "1";

    const pct = Number(gauge.dataset.gaugeValue || "0");
    const circumference = 283; // 2 * PI * 45
    const offset = circumference - (circumference * pct / 100);

    if (typeof anime === "undefined") {
      gauge.style.strokeDashoffset = offset.toString();
      return;
    }

    anime({
      targets: gauge,
      strokeDashoffset: [circumference, offset],
      duration: 1500,
      delay: 600,
      easing: "easeOutCubic"
    });
  });
}

/* ── Chart.js Integration ── */

function buildChartEmptyState(message) {
  const state = document.createElement("div");
  state.className = "nx-empty";
  state.textContent = message;
  return state;
}

function initCharts(root = document) {
  root.querySelectorAll(".chart").forEach((canvas) => {
    if (canvas.dataset.chartReady === "1") return;

    const labels = parseJsonAttribute(canvas.dataset.labels, []);
    const values = parseJsonAttribute(canvas.dataset.values, []);
    const type = canvas.dataset.chart || "bar";
    const unit = canvas.dataset.unit || "";
    const hasMeaningfulValue = values.some((value) => Number(value) > 0);

    if (!labels.length || !values.length || !hasMeaningfulValue) {
      canvas.replaceWith(buildChartEmptyState(canvas.dataset.emptyMessage || "Gosterilecek veri yok."));
      return;
    }

    if (typeof Chart === "undefined") {
      canvas.replaceWith(buildChartEmptyState("Grafik kutuphanesi yuklenemedi."));
      return;
    }

    canvas.dataset.chartReady = "1";

    new Chart(canvas, {
      type,
      data: {
        labels,
        datasets: [
          {
            data: values,
            borderColor: "#59d0c2",
            borderWidth: type === "doughnut" ? 0 : 2,
            backgroundColor: [
              "rgba(255, 157, 63, 0.72)",
              "rgba(89, 208, 194, 0.72)",
              "rgba(255, 93, 108, 0.72)",
              "rgba(246, 241, 232, 0.58)"
            ],
            tension: 0.35,
            fill: type === "line"
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: labels.length > 1,
            position: "bottom",
            labels: {
              color: "#f0eae0",
              boxWidth: 12,
              padding: 18
            }
          },
          tooltip: {
            callbacks: {
              label(context) {
                const value = context.parsed?.y ?? context.parsed ?? 0;
                return unit ? `${context.label}: ${value} ${unit}` : `${context.label}: ${value}`;
              }
            }
          }
        },
        cutout: type === "doughnut" ? "68%" : undefined,
        scales: type === "doughnut"
          ? {}
          : {
              x: {
                ticks: { color: "#8a9baa" },
                grid: { color: "rgba(255,255,255,0.04)" }
              },
              y: {
                ticks: {
                  color: "#8a9baa",
                  callback(value) {
                    return unit ? `${value} ${unit}` : value;
                  }
                },
                grid: { color: "rgba(255,255,255,0.04)" }
              }
            }
      }
    });
  });
}

/* ── Picker Fields (optimized: event delegation + deferred init + lazy render) ── */

function scheduleIdle(callback, timeout = 200) {
  if (typeof window === "undefined") {
    callback();
    return;
  }
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(callback, { timeout });
    return;
  }
  window.setTimeout(callback, 0);
}

function initPickerFields(root = document) {
  const fields = root.querySelectorAll("[data-picker-field]");
  if (!fields.length) return;

  fields.forEach((field) => {
    if (field.dataset.ready === "1") return;
    field.dataset.ready = "1";

    const searchInput = field.querySelector("[data-picker-filter]");
    const select = field.querySelector("[data-picker-select]");
    const summary = field.querySelector("[data-picker-summary]");
    const count = field.querySelector("[data-picker-count]");
    const emptyState = field.querySelector("[data-picker-empty]");
    const optionsContainer = field.querySelector("[data-picker-options]");
    const lazyPayloadNode = field.querySelector("[data-picker-payload]");
    const emptyLabel = field.dataset.pickerEmptyLabel || "Secim yapilmadi";
    const maxSelections = Number(field.dataset.pickerMax || "0");

    if (!searchInput || !select || !summary || !count || !optionsContainer) return;

    const isLazy = field.dataset.pickerLazy === "1" && lazyPayloadNode;
    const optionMeta = new Map();
    const selectedIds = new Set();

    Array.from(select.options).forEach((option) => {
      if (option.selected) selectedIds.add(option.value);
    });

    function registerOptionMetaFromButton(button) {
      const id = button.dataset.optionId || "";
      if (!id || optionMeta.has(id)) return;
      optionMeta.set(id, {
        itemId: id,
        itemName: button.dataset.optionName || "",
        itemSubtitle: button.dataset.optionSubtitle || "",
        itemColor: button.dataset.optionColor || "rgba(255, 157, 63, 0.72)"
      });
    }

    function registerOptionMetaFromData(entry) {
      const id = String(entry.id || "");
      if (!id) return;
      optionMeta.set(id, {
        itemId: id,
        itemName: entry.name || id,
        itemSubtitle: entry.subtitle || "",
        itemColor: entry.color || "rgba(255, 157, 63, 0.72)"
      });
    }

    let lazyOptionsData = [];
    if (isLazy) {
      try {
        lazyOptionsData = JSON.parse(lazyPayloadNode.textContent || "[]");
      } catch (_err) {
        lazyOptionsData = [];
      }
      lazyOptionsData.forEach(registerOptionMetaFromData);
    }

    // Pre-scan existing option buttons (SSR or hydrated already)
    Array.from(optionsContainer.querySelectorAll("[data-picker-option]"))
      .forEach(registerOptionMetaFromButton);

    function ensureSelectOption(id) {
      let option = select.querySelector(`option[value="${CSS.escape(id)}"]`);
      if (!option) {
        option = document.createElement("option");
        option.value = id;
        const meta = optionMeta.get(id);
        option.textContent = meta ? meta.itemName : id;
        select.appendChild(option);
      }
      return option;
    }

    function setSelected(id, shouldBeSelected) {
      if (maxSelections === 1 && shouldBeSelected) {
        Array.from(select.options).forEach((o) => { o.selected = false; });
        selectedIds.clear();
      }
      const option = ensureSelectOption(id);
      option.selected = shouldBeSelected;
      if (shouldBeSelected) {
        selectedIds.add(id);
      } else {
        selectedIds.delete(id);
      }
    }

    function updateButtonSelectedState(button, isSelected) {
      button.classList.toggle("is-selected", isSelected);
      button.setAttribute("aria-pressed", isSelected ? "true" : "false");
      const state = button.querySelector("[data-picker-check]");
      if (state) state.textContent = isSelected ? "Secildi" : "Ekle";
    }

    function syncAllButtonStates() {
      optionsContainer
        .querySelectorAll("[data-picker-option]")
        .forEach((button) => {
          const id = button.dataset.optionId || "";
          updateButtonSelectedState(button, selectedIds.has(id));
        });
    }

    function renderSelectedItems() {
      summary.replaceChildren();

      if (!selectedIds.size) {
        const placeholder = document.createElement("span");
        placeholder.className = "role-picker-placeholder";
        placeholder.textContent = emptyLabel;
        summary.appendChild(placeholder);
        count.textContent = emptyLabel;
        return;
      }

      count.textContent = maxSelections === 1 ? "Secildi" : `${selectedIds.size} secili`;

      const fragment = document.createDocumentFragment();
      selectedIds.forEach((id) => {
        const item = optionMeta.get(id) || {
          itemId: id,
          itemName: `Secenek #${id}`,
          itemSubtitle: id,
          itemColor: "rgba(255, 157, 63, 0.72)"
        };
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "role-chip";
        chip.title = item.itemSubtitle;
        chip.dataset.chipId = id;

        const dot = document.createElement("span");
        dot.className = "role-chip-dot";
        dot.style.background = item.itemColor;

        const label = document.createElement("span");
        label.textContent = item.itemName;

        const remove = document.createElement("span");
        remove.className = "role-chip-remove";
        remove.textContent = "x";

        chip.append(dot, label, remove);
        fragment.appendChild(chip);
      });
      summary.appendChild(fragment);
    }

    let filterHandle = null;
    function filterOptions() {
      const query = searchInput.value.trim().toLowerCase();
      const buttons = optionsContainer.querySelectorAll("[data-picker-option]");
      let visibleOptions = 0;

      buttons.forEach((button) => {
        const haystack = button.dataset.optionSearch || "";
        const matches = !query || haystack.includes(query);
        if (matches !== !button.hidden) {
          button.hidden = !matches;
        }
        if (matches) visibleOptions += 1;
      });

      if (emptyState) emptyState.hidden = visibleOptions !== 0;
    }

    function scheduleFilter() {
      if (filterHandle !== null) {
        cancelAnimationFrame(filterHandle);
      }
      filterHandle = requestAnimationFrame(() => {
        filterHandle = null;
        filterOptions();
      });
    }

    let lazyBuilt = !isLazy;
    function buildLazyOptions() {
      if (lazyBuilt) return;
      lazyBuilt = true;

      const fragment = document.createDocumentFragment();
      for (const entry of lazyOptionsData) {
        const id = String(entry.id || "");
        if (!id) continue;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "role-option-card";
        button.dataset.pickerOption = "";
        button.dataset.optionId = id;
        button.dataset.optionName = entry.name || id;
        button.dataset.optionSubtitle = entry.subtitle || "";
        button.dataset.optionColor = entry.color || "rgba(255, 157, 63, 0.72)";
        button.dataset.optionSearch = entry.search || "";
        button.setAttribute("aria-pressed", selectedIds.has(id) ? "true" : "false");
        if (selectedIds.has(id)) button.classList.add("is-selected");

        const dot = document.createElement("span");
        dot.className = "role-option-card-dot";
        dot.style.background = entry.color || "rgba(255, 157, 63, 0.72)";

        const text = document.createElement("span");
        text.className = "role-option-card-text";
        const strong = document.createElement("strong");
        strong.textContent = entry.name || id;
        const sub = document.createElement("span");
        sub.textContent = entry.subtitle || "";
        text.append(strong, sub);

        const state = document.createElement("span");
        state.className = "role-option-card-state";
        state.dataset.pickerCheck = "";
        state.textContent = selectedIds.has(id) ? "Secildi" : "Ekle";

        button.append(dot, text, state);
        fragment.appendChild(button);
      }

      if (emptyState && emptyState.parentNode === optionsContainer) {
        optionsContainer.insertBefore(fragment, emptyState);
      } else {
        optionsContainer.appendChild(fragment);
      }

      filterOptions();
    }

    // Event delegation — single listener on container (was O(n) listeners)
    optionsContainer.addEventListener("click", (event) => {
      const button = event.target.closest("[data-picker-option]");
      if (!button || !optionsContainer.contains(button)) return;
      event.preventDefault();
      const id = button.dataset.optionId || "";
      if (!id) return;
      const shouldSelect = !selectedIds.has(id);
      setSelected(id, shouldSelect);
      if (maxSelections === 1) {
        syncAllButtonStates();
      } else {
        updateButtonSelectedState(button, shouldSelect);
      }
      renderSelectedItems();
    });

    summary.addEventListener("click", (event) => {
      const chip = event.target.closest(".role-chip");
      if (!chip || !summary.contains(chip)) return;
      event.preventDefault();
      const id = chip.dataset.chipId || "";
      if (!id) return;
      setSelected(id, false);
      const button = optionsContainer.querySelector(`[data-picker-option][data-option-id="${CSS.escape(id)}"]`);
      if (button) updateButtonSelectedState(button, false);
      renderSelectedItems();
    });

    // Lazy build on first real interaction with the options container
    function triggerLazyBuild() {
      if (lazyBuilt) return;
      buildLazyOptions();
    }

    if (isLazy) {
      searchInput.addEventListener("focus", triggerLazyBuild, { once: true });
      searchInput.addEventListener("input", triggerLazyBuild, { once: true });
      optionsContainer.addEventListener("pointerdown", triggerLazyBuild, { once: true });
    }

    searchInput.addEventListener("input", () => {
      if (!lazyBuilt) triggerLazyBuild();
      scheduleFilter();
    });

    // Defer expensive initial paint work until browser idle so the page stays responsive
    scheduleIdle(() => {
      renderSelectedItems();
      if (!isLazy) {
        syncAllButtonStates();
        filterOptions();
      }
    });
  });
}

/* ── Conditional Fields (Settings page — unchanged) ── */

function initConditionalFields(root = document) {
  root.querySelectorAll("[data-toggle-target]").forEach((control) => {
    if (control.dataset.ready === "1") return;
    control.dataset.ready = "1";

    const targetName = control.dataset.toggleTarget;
    const visibleValue = control.dataset.toggleValue || "manual";
    const fields = Array.from(document.querySelectorAll(`[data-conditional-field='${targetName}']`));

    function syncVisibility() {
      const shouldShow = control.value === visibleValue;
      fields.forEach((field) => {
        field.classList.toggle("is-hidden", !shouldShow);
      });
    }

    control.addEventListener("change", syncVisibility);
    syncVisibility();
  });
}

/* ── Nav Animations ── */

function initNavAnimations() {
  const nav = document.querySelector('.nav');
  if (!nav || typeof anime === 'undefined') return;

  const links = Array.from(nav.querySelectorAll('a'));
  const activeLink = nav.querySelector('a.active');

  // Glow pulse for active link
  if (activeLink) {
    anime({
      targets: activeLink,
      boxShadow: [
        '0 0 0 rgba(255, 157, 63, 0)',
        '0 0 20px rgba(255, 157, 63, 0.15)',
        '0 0 0 rgba(255, 157, 63, 0)'
      ],
      duration: 2500,
      easing: 'easeInOutSine',
      loop: true
    });
  }

  // Hover animations
  links.forEach(link => {
    link.addEventListener('mouseenter', () => {
      if (link.classList.contains('active')) return;
      anime({
        targets: link,
        translateX: [0, 4],
        duration: 300,
        easing: 'easeOutCubic'
      });
    });

    link.addEventListener('mouseleave', () => {
      if (link.classList.contains('active')) return;
      anime({
        targets: link,
        translateX: 0,
        duration: 300,
        easing: 'easeOutCubic'
      });
    });
  });

  // Entry animation
  if (!sessionStorage.getItem('navAnimated')) {
    anime({
      targets: links,
      opacity: [0, 1],
      translateX: [-20, 0],
      delay: anime.stagger(80, { start: 200 }),
      duration: 600,
      easing: 'easeOutCubic'
    });
    sessionStorage.setItem('navAnimated', 'true');
  }
}

/* ── 3D Tilt on Hover ── */

function initTiltHover(root = document) {
  root.querySelectorAll('.nx-tile, .nx-spotlight, .nx-impact-card').forEach((tile) => {
    if (tile.dataset.tiltReady === '1') return;
    tile.dataset.tiltReady = '1';

    tile.addEventListener('mousemove', (e) => {
      const rect = tile.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      const rotateX = ((y - centerY) / centerY) * -2;
      const rotateY = ((x - centerX) / centerX) * 2;

      tile.style.transform = `perspective(800px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateY(-3px)`;
    });

    tile.addEventListener('mouseleave', () => {
      tile.style.transform = '';
    });
  });
}

/* -- Smart Scroll Regions -- */

function syncScrollRegions(root = document) {
  root
    .querySelectorAll(
      ".nx-roster, .nx-role-history, .nx-message-audit-list, .nx-alert-list, .nx-channel-list, .nx-note-list, .nx-guard-log-stream"
    )
    .forEach((region) => {
      const hasOverflow = region.scrollHeight > region.clientHeight + 2;
      region.classList.toggle("nx-scroll-region--active", hasOverflow);
    });
}

let scrollRegionFrame = null;

function scheduleScrollRegionSync(root = document) {
  if (scrollRegionFrame !== null) {
    cancelAnimationFrame(scrollRegionFrame);
  }

  scrollRegionFrame = requestAnimationFrame(() => {
    syncScrollRegions(root);
    scrollRegionFrame = null;
  });
}

/* ── Confirm Modal (replaces native confirm + hx-confirm) ── */

const nxConfirmState = {
  modal: null,
  titleEl: null,
  messageEl: null,
  acceptBtn: null,
  cancelBtn: null,
  acceptLabelEl: null,
  cancelLabelEl: null,
  iconEl: null,
  currentResolver: null,
  previouslyFocused: null,
  escHandler: null,
  ready: false
};

function ensureConfirmModal() {
  if (nxConfirmState.ready) return nxConfirmState;

  const modal = document.getElementById("nx-confirm-modal");
  if (!modal) return null;

  nxConfirmState.modal = modal;
  nxConfirmState.titleEl = modal.querySelector("[data-confirm-title]");
  nxConfirmState.messageEl = modal.querySelector("[data-confirm-message]");
  nxConfirmState.acceptBtn = modal.querySelector("[data-confirm-accept]");
  nxConfirmState.cancelBtn = modal.querySelector("[data-confirm-cancel]");
  nxConfirmState.acceptLabelEl = modal.querySelector("[data-confirm-accept-label]");
  nxConfirmState.cancelLabelEl = modal.querySelector("[data-confirm-cancel-label]");
  nxConfirmState.iconEl = modal.querySelector("[data-confirm-icon] i");

  if (!nxConfirmState.acceptBtn || !nxConfirmState.cancelBtn) return null;

  nxConfirmState.acceptBtn.addEventListener("click", () => resolveConfirm(true));
  nxConfirmState.cancelBtn.addEventListener("click", () => resolveConfirm(false));

  modal.querySelectorAll("[data-confirm-dismiss]").forEach((el) => {
    el.addEventListener("click", () => resolveConfirm(false));
  });

  nxConfirmState.escHandler = (event) => {
    if (event.key === "Escape" && !modal.hidden) {
      event.preventDefault();
      resolveConfirm(false);
    }
  };

  nxConfirmState.ready = true;
  return nxConfirmState;
}

function resolveConfirm(result) {
  const state = nxConfirmState;
  if (!state.modal) return;

  const resolver = state.currentResolver;
  state.currentResolver = null;
  state.modal.classList.remove("is-open");
  // Match CSS transition; snap hidden after animation completes so focus/tab don't leak through
  window.setTimeout(() => {
    if (!state.currentResolver) {
      state.modal.hidden = true;
    }
  }, 220);

  if (state.escHandler) {
    document.removeEventListener("keydown", state.escHandler);
  }

  if (state.previouslyFocused && typeof state.previouslyFocused.focus === "function") {
    try {
      state.previouslyFocused.focus({ preventScroll: true });
    } catch (_err) {
      /* ignore */
    }
  }
  state.previouslyFocused = null;

  if (typeof resolver === "function") {
    resolver(Boolean(result));
  }
}

function nxConfirm(options) {
  return new Promise((resolve) => {
    const state = ensureConfirmModal();
    if (!state) {
      // Fallback to native confirm if modal isn't mounted for whatever reason
      resolve(window.confirm(options && options.message ? options.message : "Emin misiniz?"));
      return;
    }

    if (typeof state.currentResolver === "function") {
      // Another confirm is already open — cancel it before showing a new one
      state.currentResolver(false);
    }

    const {
      title = "Emin misiniz?",
      message = "Bu işlemi gerçekleştirmek istediğinize emin misiniz?",
      confirmLabel = "Onayla",
      cancelLabel = "Vazgeç",
      tone = "danger",
      icon = null
    } = options || {};

    state.titleEl.textContent = title;
    state.messageEl.textContent = message;
    state.acceptLabelEl.textContent = confirmLabel;
    state.cancelLabelEl.textContent = cancelLabel;
    state.modal.dataset.tone = tone;
    if (state.iconEl) {
      const iconClass = icon || (tone === "info"
        ? "fa-solid fa-circle-info"
        : tone === "warning"
          ? "fa-solid fa-triangle-exclamation"
          : "fa-solid fa-triangle-exclamation");
      state.iconEl.className = iconClass;
    }

    state.previouslyFocused = document.activeElement;
    state.currentResolver = resolve;
    state.modal.hidden = false;
    // Force reflow before applying class for transition
    // eslint-disable-next-line no-unused-expressions
    state.modal.offsetHeight;
    state.modal.classList.add("is-open");

    document.addEventListener("keydown", state.escHandler);

    window.setTimeout(() => {
      try {
        state.acceptBtn.focus({ preventScroll: true });
      } catch (_err) {
        /* ignore */
      }
    }, 40);
  });
}

function extractConfirmOptionsFromElement(element) {
  if (!element) return null;
  const message =
    element.getAttribute("data-confirm-message") ||
    element.getAttribute("data-confirm") ||
    element.getAttribute("hx-confirm");
  if (!message) return null;

  return {
    title: element.getAttribute("data-confirm-title") || "Emin misiniz?",
    message,
    confirmLabel: element.getAttribute("data-confirm-accept") || "Onayla",
    cancelLabel: element.getAttribute("data-confirm-cancel") || "Vazgeç",
    tone: element.getAttribute("data-confirm-tone") || "danger",
    icon: element.getAttribute("data-confirm-icon") || null
  };
}

function initConfirmHooks() {
  if (typeof document === "undefined") return;
  if (document.body && document.body.dataset.nxConfirmHooks === "1") return;
  if (document.body) document.body.dataset.nxConfirmHooks = "1";

  // HTMX integration — replaces native window.confirm() for hx-confirm elements
  document.body.addEventListener("htmx:confirm", (event) => {
    const source = event.detail && event.detail.elt;
    const options = extractConfirmOptionsFromElement(source);
    if (!options) return;
    event.preventDefault();
    nxConfirm(options).then((accepted) => {
      if (accepted && event.detail && typeof event.detail.issueRequest === "function") {
        event.detail.issueRequest(true);
      }
    });
  });

  // Generic data-confirm for non-HTMX forms/buttons (click interception)
  document.body.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented) return;
      const target = event.target && event.target.closest
        ? event.target.closest("[data-confirm], [data-confirm-message]")
        : null;
      if (!target) return;
      if (target.dataset.confirmInProgress === "1") return;
      // Skip HTMX elements — they go through htmx:confirm above
      if (target.hasAttribute("hx-delete") || target.hasAttribute("hx-post") ||
          target.hasAttribute("hx-put") || target.hasAttribute("hx-patch") ||
          target.hasAttribute("hx-get")) return;

      const options = extractConfirmOptionsFromElement(target);
      if (!options) return;

      event.preventDefault();
      event.stopPropagation();

      nxConfirm(options).then((accepted) => {
        if (!accepted) return;
        target.dataset.confirmInProgress = "1";
        try {
          if (target.tagName === "FORM") {
            target.submit();
          } else if (target.form && target.type === "submit") {
            target.form.submit();
          } else if (typeof target.click === "function") {
            target.click();
          }
        } finally {
          window.setTimeout(() => {
            delete target.dataset.confirmInProgress;
          }, 300);
        }
      });
    },
    true
  );
}

/* ── Master Initializer ── */

function initializeDashboard(root = document, isInitialLoad = false) {
  initSidebarNavState();
  animateCounters(root);

  // Functions handle their own fallback state logic
  animateBarFills(root);
  animateTileEntrances(root);

  animateGauges(root);
  initCharts(root);
  initPickerFields(root);
  initConditionalFields(root);
  initTiltHover(root);
  scheduleScrollRegionSync(root);

  if (isInitialLoad) {
    initNavAnimations();
    initConfirmHooks();
  }

  if (typeof sessionStorage !== "undefined" && !sessionStorage.getItem("siteAnimated")) {
    sessionStorage.setItem("siteAnimated", "true");
  }
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", () => {
    initializeDashboard(document, true);
  });
} else {
  initializeDashboard(document, true);
}

window.addEventListener("resize", () => {
  scheduleScrollRegionSync(document);
});

document.body.addEventListener("htmx:afterSwap", (event) => {
  initializeDashboard(event.target, false);
});
