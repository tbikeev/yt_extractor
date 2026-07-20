const view = document.getElementById("view");
const tplHome = document.getElementById("tpl-home");
const tplWatch = document.getElementById("tpl-watch");
const tplSearch = document.getElementById("tpl-search");

const URL_HISTORY_KEY = "yt_extractor.url_history";
const LANG_PREF_KEY = "yt_extractor.language";
const URL_HISTORY_MAX = 20;

let pollTimer = null;
let activeCueObserver = null;
let lastLibraryKey = "";
let lastJobsKey = "";

function loadUrlHistory() {
  try {
    const raw = localStorage.getItem(URL_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeHistoryEntry).filter(Boolean);
  } catch {
    return [];
  }
}

function normalizeHistoryEntry(entry) {
  if (typeof entry === "string") {
    const url = entry.trim();
    return url ? { url, title: null, youtube_id: null, added_at: null } : null;
  }
  if (entry && typeof entry.url === "string" && entry.url.trim()) {
    return {
      url: entry.url.trim(),
      title: entry.title || null,
      youtube_id: entry.youtube_id || null,
      added_at: entry.added_at || null,
    };
  }
  return null;
}

function saveUrlHistory(entries) {
  localStorage.setItem(URL_HISTORY_KEY, JSON.stringify(entries.slice(0, URL_HISTORY_MAX)));
}

function rememberUrl(url, meta = {}) {
  const cleaned = url.trim();
  if (!cleaned) return;
  const prev = loadUrlHistory().find((e) => e.url === cleaned);
  const entry = {
    url: cleaned,
    title: meta.title || prev?.title || null,
    youtube_id: meta.youtube_id || prev?.youtube_id || null,
    added_at: meta.added_at || prev?.added_at || new Date().toISOString(),
  };
  const next = [entry, ...loadUrlHistory().filter((e) => e.url !== cleaned)];
  saveUrlHistory(next);
}

function enrichUrlHistoryFromVideos(videos) {
  const byId = new Map(videos.map((v) => [v.youtube_id, v]));
  let changed = false;
  const next = loadUrlHistory().map((entry) => {
    const yt = entry.youtube_id || youtubeIdFromUrl(entry.url);
    const video = yt ? byId.get(yt) : null;
    if (!video) return entry;
    const title = entry.title || video.title;
    const youtube_id = entry.youtube_id || video.youtube_id;
    if (title !== entry.title || youtube_id !== entry.youtube_id) {
      changed = true;
      return { ...entry, title, youtube_id };
    }
    return entry;
  });
  if (changed) saveUrlHistory(next);
  return changed;
}

function youtubeIdFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1).split("/")[0] || null;
    return u.searchParams.get("v");
  } catch {
    return null;
  }
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

  const entries = loadUrlHistory();
  datalist.replaceChildren(
    ...entries.map((entry) => {
      const opt = document.createElement("option");
      opt.value = entry.url;
      opt.label = entry.title || shortenUrl(entry.url);
      return opt;
    })
  );

  if (!entries.length) {
    panel.hidden = true;
    list.replaceChildren();
    return;
  }

  panel.hidden = false;
  list.replaceChildren(
    ...entries.slice(0, 8).map((entry) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "url-history-item";
      btn.title = entry.url;
      const title = entry.title || shortenUrl(entry.url);
      const metaParts = [];
      if (entry.added_at) metaParts.push(fmtDate(entry.added_at));
      if (entry.youtube_id) metaParts.push(entry.youtube_id);
      btn.innerHTML = `
        <span class="url-history-title">${escapeHtml(title)}</span>
        <span class="url-history-meta">${escapeHtml(metaParts.join(" · ") || entry.url)}</span>
      `;
      btn.addEventListener("click", () => {
        input.value = entry.url;
        input.focus();
      });
      li.appendChild(btn);
      return li;
    })
  );
}

function fmtDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
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
  lastLibraryKey = "";
  lastJobsKey = "";
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

  $("#clear-job-errors")?.addEventListener("click", async () => {
    try {
      await api("/api/jobs/errors", { method: "DELETE" });
      await refreshJobsAndLibrary();
    } catch (err) {
      alert(err.message);
    }
  });

  // Seed history from prior download jobs (server), then enrich titles from library.
  Promise.all([api("/api/jobs?limit=50"), api("/api/videos")])
    .then(([jobs, videos]) => {
      const existing = loadUrlHistory();
      const byUrl = new Map(existing.map((e) => [e.url, e]));
      for (const job of jobs) {
        if (!job.url) continue;
        const prev = byUrl.get(job.url);
        byUrl.set(job.url, {
          url: job.url,
          title: prev?.title || null,
          youtube_id: job.youtube_id || prev?.youtube_id || youtubeIdFromUrl(job.url),
          added_at: prev?.added_at || job.created_at || new Date().toISOString(),
        });
      }
      saveUrlHistory([...byUrl.values()]);
      if (enrichUrlHistoryFromVideos(videos)) renderUrlHistoryUI();
      else renderUrlHistoryUI();
    })
    .catch(() => {});

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
      rememberUrl(url, {
        youtube_id: job.youtube_id || youtubeIdFromUrl(url),
        added_at: new Date().toISOString(),
      });
      localStorage.setItem(LANG_PREF_KEY, lang.value);
      renderUrlHistoryUI();
      status.textContent = `Queued — ${job.message}`;
      $("#url").value = "";
      await refreshJobsAndLibrary();
    } catch (err) {
      rememberUrl(url, {
        youtube_id: youtubeIdFromUrl(url),
        added_at: new Date().toISOString(),
      });
      renderUrlHistoryUI();
      status.classList.add("error");
      status.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  await refreshJobsAndLibrary();
  scheduleJobPolling();
}

function jobsSnapshot(jobs) {
  return JSON.stringify(
    jobs.map((j) => [j.id, j.status, j.stage, j.message, j.error, j.updated_at])
  );
}

function librarySnapshot(videos) {
  return JSON.stringify(
    videos.map((v) => [v.id, v.title, v.has_subs, v.has_video, v.created_at, v.duration])
  );
}

function scheduleJobPolling(jobs) {
  clearInterval(pollTimer);
  pollTimer = null;
  if (!jobs) return;
  const hasActive = jobs.some((j) => j.status === "queued" || j.status === "running");
  if (hasActive) {
    pollTimer = setInterval(refreshJobsAndLibrary, 2500);
  }
}

function renderJobPanel(jobs) {
  const jobPanel = $("#job-panel");
  const jobList = $("#job-list");
  const clearErrorsBtn = $("#clear-job-errors");
  if (!jobPanel || !jobList) return;

  const active = jobs.filter((j) => j.status === "queued" || j.status === "running");
  const recentErrors = jobs.filter((j) => j.status === "error");
  const softWarnings = jobs.filter((j) => j.status === "done" && j.error);
  const hasClearable = recentErrors.length + softWarnings.length > 0;

  if (active.length || recentErrors.length || softWarnings.length) {
    jobPanel.hidden = false;
    if (clearErrorsBtn) clearErrorsBtn.hidden = !hasClearable;
    jobList.replaceChildren(
      ...[...active, ...recentErrors, ...softWarnings].map((job) => {
        const el = document.createElement("div");
        const isError = job.status === "error";
        el.className = `job${isError ? " error" : ""}`;
        const when = job.created_at ? fmtDate(job.created_at) : "";
        if (job.status === "done" && job.error) {
          el.textContent = `${when ? when + " — " : ""}${job.message}${job.youtube_id ? ` · ${job.youtube_id}` : ""}`;
        } else if (isError) {
          el.textContent = `${when ? when + " — " : ""}Failed (${job.youtube_id || "video"}): ${job.error || job.message}`;
        } else {
          el.textContent = `${when ? when + " — " : ""}${job.stage}: ${job.message}${job.youtube_id ? ` · ${job.youtube_id}` : ""}`;
        }
        return el;
      })
    );
  } else {
    jobPanel.hidden = true;
    jobList.replaceChildren();
    if (clearErrorsBtn) clearErrorsBtn.hidden = true;
  }
}

function renderLibrary(videos, { animate = false } = {}) {
  const libraryEl = $("#library");
  if (!libraryEl) return;

  if (!videos.length) {
    libraryEl.innerHTML = `<p class="empty">No videos yet. Paste a YouTube link above to download your first one.</p>`;
    return;
  }

  libraryEl.replaceChildren(
    ...videos.map((v, i) => {
      const row = document.createElement("article");
      row.className = animate ? "video-row" : "video-row is-stable";
      if (animate) row.style.animationDelay = `${Math.min(i, 8) * 40}ms`;

      const thumb = v.thumbnail_url
        ? `<img class="thumb" src="${v.thumbnail_url}" alt="" loading="lazy" />`
        : `<div class="thumb placeholder">No thumb</div>`;

      const subsBtns = v.has_subs
        ? `<a class="btn ghost" href="${v.subs_vtt_url}" download="${escapeHtml(v.title)}.vtt">VTT</a>
           <a class="btn ghost" href="${v.subs_json_url}" download="${escapeHtml(v.title)}.json">JSON</a>`
        : "";

      row.innerHTML = `
        ${thumb}
        <div class="video-info">
          <h3>${escapeHtml(v.title)}</h3>
          <p>${fmtDate(v.created_at)} · ${fmtTime(v.duration)} · ${v.has_subs ? "subs indexed" : "no subs"} · ${escapeHtml(v.youtube_id)}</p>
        </div>
        <div class="video-actions">
          <a class="btn primary" href="#/watch/${v.id}" data-link>Watch</a>
          ${subsBtns}
          <button type="button" class="btn ghost" data-delete="${v.id}">Delete</button>
        </div>
      `;
      row.querySelector("[data-delete]").addEventListener("click", async () => {
        if (!confirm(`Delete “${v.title}”?`)) return;
        await api(`/api/videos/${v.id}`, { method: "DELETE" });
        lastLibraryKey = "";
        await refreshJobsAndLibrary();
      });
      return row;
    })
  );
}

async function refreshJobsAndLibrary() {
  const libraryEl = $("#library");
  if (!libraryEl) return;

  try {
    const [videos, jobs] = await Promise.all([api("/api/videos"), api("/api/jobs?limit=20")]);

    if (enrichUrlHistoryFromVideos(videos)) renderUrlHistoryUI();

    const jobsKey = jobsSnapshot(jobs);
    if (jobsKey !== lastJobsKey) {
      lastJobsKey = jobsKey;
      renderJobPanel(jobs);
    }
    scheduleJobPolling(jobs);

    const libKey = librarySnapshot(videos);
    if (libKey !== lastLibraryKey) {
      const firstPaint = !lastLibraryKey;
      lastLibraryKey = libKey;
      renderLibrary(videos, { animate: firstPaint });
    }
  } catch (err) {
    libraryEl.innerHTML = `<p class="empty">Could not load library: ${escapeHtml(err.message)}</p>`;
    lastLibraryKey = "";
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
  $("#watch-meta").textContent = `${fmtDate(video.created_at)} · ${fmtTime(video.duration)} · ${video.has_subs ? `${cues.length} cues` : "no subtitles"}`;

  const watchActions = $("#watch-actions");
  if (video.has_subs && video.subs_vtt_url && video.subs_json_url) {
    watchActions.hidden = false;
    const vtt = $("#download-subs-vtt");
    const json = $("#download-subs-json");
    vtt.href = video.subs_vtt_url;
    json.href = video.subs_json_url;
    vtt.setAttribute("download", `${video.title}.vtt`);
    json.setAttribute("download", `${video.title}.json`);
  } else if (watchActions) {
    watchActions.hidden = true;
  }

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
