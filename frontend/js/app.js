const view = document.getElementById("view");
const tplHome = document.getElementById("tpl-home");
const tplWatch = document.getElementById("tpl-watch");
const tplSearch = document.getElementById("tpl-search");

const URL_HISTORY_KEY = "yt_extractor.url_history";
const LANG_PREF_KEY = "yt_extractor.language";
const URL_HISTORY_MAX = 20;

let pollTimer = null;
let activeCueObserver = null;

function loadUrlHistory() {
  try {
    const raw = localStorage.getItem(URL_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((u) => typeof u === "string" && u.trim()) : [];
  } catch {
    return [];
  }
}

function saveUrlHistory(urls) {
  localStorage.setItem(URL_HISTORY_KEY, JSON.stringify(urls.slice(0, URL_HISTORY_MAX)));
}

function rememberUrl(url) {
  const cleaned = url.trim();
  if (!cleaned) return;
  const next = [cleaned, ...loadUrlHistory().filter((u) => u !== cleaned)];
  saveUrlHistory(next);
}

function clearUrlHistory() {
  localStorage.removeItem(URL_HISTORY_KEY);
}

function renderUrlHistoryUI() {
  const datalist = $("#url-history");
  const panel = $("#url-history-panel");
  const list = $("#url-history-list");
  const input = $("#url");
  if (!datalist || !panel || !list || !input) return;

  const urls = loadUrlHistory();
  datalist.replaceChildren(
    ...urls.map((url) => {
      const opt = document.createElement("option");
      opt.value = url;
      return opt;
    })
  );

  if (!urls.length) {
    panel.hidden = true;
    list.replaceChildren();
    return;
  }

  panel.hidden = false;
  list.replaceChildren(
    ...urls.slice(0, 8).map((url) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "url-history-item";
      btn.title = url;
      btn.textContent = shortenUrl(url);
      btn.addEventListener("click", () => {
        input.value = url;
        input.focus();
      });
      li.appendChild(btn);
      return li;
    })
  );
}

function shortenUrl(url) {
  try {
    const u = new URL(url);
    const id = u.searchParams.get("v") || u.pathname.replace(/^\//, "");
    if (id && id.length <= 20) return `${u.hostname.replace("www.", "")} · ${id}`;
  } catch {
    /* fall through */
  }
  return url.length > 48 ? `${url.slice(0, 45)}…` : url;
}

function $(sel, root = document) {
  return root.querySelector(sel);
}

function fmtTime(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return "—";
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function setMode(mode) {
  document.body.classList.toggle("mode-watch", mode === "watch");
  document.querySelectorAll("[data-nav]").forEach((el) => {
    const nav = el.getAttribute("data-nav");
    el.classList.toggle("active", (mode === "home" && nav === "library") || mode === nav);
  });
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const data = await res.json();
      detail = data.detail || JSON.stringify(data);
    } catch {
      /* ignore */
    }
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  if (res.status === 204) return null;
  return res.json();
}

function route() {
  const hash = location.hash || "#/";
  const [path, query] = hash.replace(/^#/, "").split("?");
  const parts = path.split("/").filter(Boolean);
  clearInterval(pollTimer);
  pollTimer = null;
  if (activeCueObserver) {
    cancelAnimationFrame(activeCueObserver);
    activeCueObserver = null;
  }

  if (parts[0] === "watch" && parts[1]) {
    renderWatch(parts[1], new URLSearchParams(query || ""));
  } else if (parts[0] === "search") {
    renderSearch(new URLSearchParams(query || ""));
  } else {
    renderHome();
  }
}

async function renderHome() {
  setMode("home");
  view.replaceChildren(tplHome.content.cloneNode(true));

  const form = $("#download-form");
  const status = $("#form-status");
  const btn = $("#download-btn");
  const lang = $("#language");
  const savedLang = localStorage.getItem(LANG_PREF_KEY);
  if (savedLang && [...lang.options].some((o) => o.value === savedLang)) {
    lang.value = savedLang;
  }
  lang.addEventListener("change", () => localStorage.setItem(LANG_PREF_KEY, lang.value));

  renderUrlHistoryUI();
  $("#clear-url-history")?.addEventListener("click", () => {
    clearUrlHistory();
    renderUrlHistoryUI();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    status.hidden = false;
    status.classList.remove("error");
    status.textContent = "Starting download…";
    btn.disabled = true;
    const url = $("#url").value.trim();
    try {
      const job = await api("/api/download", {
        method: "POST",
        body: JSON.stringify({
          url,
          language: lang.value,
        }),
      });
      rememberUrl(url);
      localStorage.setItem(LANG_PREF_KEY, lang.value);
      renderUrlHistoryUI();
      status.textContent = `Queued — ${job.message}`;
      $("#url").value = "";
      await refreshJobsAndLibrary();
    } catch (err) {
      // Still remember the URL so a failed attempt is easy to retry.
      rememberUrl(url);
      renderUrlHistoryUI();
      status.classList.add("error");
      status.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  await refreshJobsAndLibrary();
  pollTimer = setInterval(refreshJobsAndLibrary, 2500);
}

async function refreshJobsAndLibrary() {
  const libraryEl = $("#library");
  const jobList = $("#job-list");
  if (!libraryEl) return;

  try {
    const [videos, jobs] = await Promise.all([api("/api/videos"), api("/api/jobs?limit=8")]);
    const active = jobs.filter((j) => j.status === "queued" || j.status === "running");
    const recentErrors = jobs.filter((j) => j.status === "error").slice(0, 3);
    const softWarnings = jobs
      .filter((j) => j.status === "done" && j.error)
      .slice(0, 2);

    if (active.length || recentErrors.length || softWarnings.length) {
      jobList.hidden = false;
      jobList.replaceChildren(
        ...[...active, ...recentErrors, ...softWarnings].map((job) => {
          const el = document.createElement("div");
          const isError = job.status === "error";
          el.className = `job${isError ? " error" : ""}`;
          if (job.status === "done" && job.error) {
            el.textContent = `${job.message}${job.youtube_id ? ` · ${job.youtube_id}` : ""}`;
          } else if (isError) {
            el.textContent = `Failed (${job.youtube_id || "video"}): ${job.error || job.message}`;
          } else {
            el.textContent = `${job.stage}: ${job.message}${job.youtube_id ? ` · ${job.youtube_id}` : ""}`;
          }
          return el;
        })
      );
    } else {
      jobList.hidden = true;
      jobList.replaceChildren();
    }

    if (!videos.length) {
      libraryEl.innerHTML = `<p class="empty">No videos yet. Paste a YouTube link above to download your first one.</p>`;
      return;
    }

    libraryEl.replaceChildren(
      ...videos.map((v, i) => {
        const row = document.createElement("article");
        row.className = "video-row";
        row.style.animationDelay = `${Math.min(i, 8) * 40}ms`;

        const thumb = v.thumbnail_url
          ? `<img class="thumb" src="${v.thumbnail_url}" alt="" loading="lazy" />`
          : `<div class="thumb placeholder">No thumb</div>`;

        row.innerHTML = `
          ${thumb}
          <div class="video-info">
            <h3>${escapeHtml(v.title)}</h3>
            <p>${fmtTime(v.duration)} · ${v.has_subs ? "subs indexed" : "no subs"} · ${escapeHtml(v.youtube_id)}</p>
          </div>
          <div class="video-actions">
            <a class="btn primary" href="#/watch/${v.id}" data-link>Watch</a>
            <button type="button" class="btn ghost" data-delete="${v.id}">Delete</button>
          </div>
        `;
        row.querySelector("[data-delete]").addEventListener("click", async () => {
          if (!confirm(`Delete “${v.title}”?`)) return;
          await api(`/api/videos/${v.id}`, { method: "DELETE" });
          await refreshJobsAndLibrary();
        });
        return row;
      })
    );
  } catch (err) {
    libraryEl.innerHTML = `<p class="empty">Could not load library: ${escapeHtml(err.message)}</p>`;
  }
}

async function renderWatch(videoId, params) {
  setMode("watch");
  view.replaceChildren(tplWatch.content.cloneNode(true));
  $("#back-btn").addEventListener("click", () => {
    location.hash = "#/";
  });

  const player = $("#player");
  const cuesEl = $("#cues");
  const filterInput = $("#cue-filter");

  let video;
  let cues = [];
  try {
    [video, cues] = await Promise.all([
      api(`/api/videos/${videoId}`),
      api(`/api/videos/${videoId}/cues`),
    ]);
  } catch (err) {
    view.innerHTML = `<p class="empty">Video not found: ${escapeHtml(err.message)}</p>`;
    return;
  }

  $("#watch-title").textContent = video.title;
  $("#watch-meta").textContent = `${fmtTime(video.duration)} · ${video.has_subs ? `${cues.length} cues` : "no subtitles"}`;

  if (video.video_url) {
    player.src = video.video_url;
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.label = video.language || "Subtitles";
    track.srclang = video.language || "en";
    track.src = `/media/videos/${video.youtube_id}/subs.vtt`;
    track.default = true;
    player.appendChild(track);
  }

  const tParam = params.get("t");
  if (tParam != null) {
    const t = Number(tParam);
    if (!Number.isNaN(t)) {
      player.addEventListener(
        "loadedmetadata",
        () => {
          player.currentTime = t;
          player.play().catch(() => {});
        },
        { once: true }
      );
    }
  }

  function renderCues(filter = "") {
    const q = filter.trim().toLowerCase();
    const filtered = q ? cues.filter((c) => c.text.toLowerCase().includes(q)) : cues;
    if (!filtered.length) {
      cuesEl.innerHTML = `<p class="empty" style="padding:1rem;color:#8b97a6">No matching cues.</p>`;
      return;
    }
    cuesEl.replaceChildren(
      ...filtered.map((cue) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "cue";
        btn.dataset.start = String(cue.start);
        btn.setAttribute("role", "listitem");
        btn.innerHTML = `
          <span class="cue-time">${fmtTime(cue.start)}</span>
          <span class="cue-text">${highlight(cue.text, q)}</span>
        `;
        btn.addEventListener("click", () => {
          player.currentTime = cue.start;
          player.play().catch(() => {});
        });
        return btn;
      })
    );
  }

  renderCues();
  filterInput.addEventListener("input", () => renderCues(filterInput.value));

  let lastActive = null;
  const tick = () => {
    const t = player.currentTime || 0;
    let active = null;
    for (const cue of cues) {
      if (t >= cue.start && t < cue.end) {
        active = cue;
        break;
      }
    }
    if (active !== lastActive) {
      lastActive = active;
      const start = active ? String(active.start) : null;
      cuesEl.querySelectorAll(".cue").forEach((el) => {
        const isActive = start != null && el.dataset.start === start;
        el.classList.toggle("active", isActive);
        if (isActive) {
          el.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
      });
    }
    activeCueObserver = requestAnimationFrame(tick);
  };
  activeCueObserver = requestAnimationFrame(tick);
}

async function renderSearch(params) {
  setMode("search");
  view.replaceChildren(tplSearch.content.cloneNode(true));
  const form = $("#search-form");
  const input = $("#search-q");
  const results = $("#search-results");
  const initial = params.get("q") || "";
  input.value = initial;

  async function runSearch(q) {
    if (!q.trim()) {
      results.innerHTML = `<p class="empty">Type a word or phrase from any transcript.</p>`;
      return;
    }
    location.hash = `#/search?q=${encodeURIComponent(q.trim())}`;
    results.innerHTML = `<p class="empty">Searching…</p>`;
    try {
      const hits = await api(`/api/search?q=${encodeURIComponent(q.trim())}`);
      if (!hits.length) {
        results.innerHTML = `<p class="empty">No matches for “${escapeHtml(q.trim())}”.</p>`;
        return;
      }
      results.replaceChildren(
        ...hits.map((hit, i) => {
          const a = document.createElement("a");
          a.className = "search-hit";
          a.href = `#/watch/${hit.video_id}?t=${hit.start}`;
          a.style.animationDelay = `${Math.min(i, 10) * 30}ms`;
          a.innerHTML = `
            <p class="title">${escapeHtml(hit.title)}</p>
            <p class="meta">${fmtTime(hit.start)} → ${fmtTime(hit.end)}</p>
            <p class="snippet">${formatSnippet(hit.snippet)}</p>
          `;
          return a;
        })
      );
    } catch (err) {
      results.innerHTML = `<p class="empty">Search failed: ${escapeHtml(err.message)}</p>`;
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    runSearch(input.value);
  });

  if (initial) runSearch(initial);
  else results.innerHTML = `<p class="empty">Type a word or phrase from any transcript.</p>`;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function highlight(text, q) {
  const safe = escapeHtml(text);
  if (!q) return safe;
  const re = new RegExp(`(${escapeRegExp(q)})`, "ig");
  return safe.replace(re, "<mark>$1</mark>");
}

function formatSnippet(snippet) {
  return escapeHtml(snippet)
    .replaceAll("«", "<mark>")
    .replaceAll("»", "</mark>");
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

document.addEventListener("click", (e) => {
  const link = e.target.closest("[data-link]");
  if (!link) return;
  const href = link.getAttribute("href");
  if (href && href.startsWith("#")) {
    e.preventDefault();
    if (location.hash !== href) location.hash = href;
    else route();
  }
});

window.addEventListener("hashchange", route);
route();
