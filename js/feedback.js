// "Send feedback": a small dialog that posts to the sync Worker, which keeps the message for the
// app's owner (Cloudflare dashboard, Workers KV). No account or email needed.
(function () {
  "use strict";
  const DH = window.DH;
  const { esc } = DH.fmt;
  let dialog = null;

  function build() {
    dialog = document.createElement("dialog");
    dialog.className = "feedback";
    dialog.setAttribute("aria-labelledby", "fb-title");
    document.body.appendChild(dialog);
    dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); }); // backdrop
    dialog.addEventListener("submit", send);
  }

  function open() {
    if (!dialog) build();
    const u = DH.store.get("user", null);
    const league = /^#\/\d+/.test(location.hash) ? document.title.replace(/ · Front Office$/, "") : "";
    dialog.innerHTML = `<form method="dialog" class="stack-tight">
      <h2 id="fb-title">Send feedback</h2>
      <p class="small muted">Ideas, bugs, a recommendation that looked wrong: anything helps. It goes straight to the person who runs Front Office.</p>
      <label class="field"><span>Message</span><textarea name="message" rows="6" maxlength="4000" required placeholder="What's on your mind?"></textarea></label>
      <label class="field"><span>Your name or Sleeper username <span class="muted">(optional, so I know who to ask)</span></span>
        <input type="text" name="from" maxlength="120" autocomplete="nickname" value="${esc(u ? u.username : "")}"></label>
      ${league ? `<label class="check"><input type="checkbox" name="withPage" checked> Include the page I'm on (${esc(league)})</label>` : ""}
      <p class="form-msg" data-fb-msg role="status"></p>
      <div class="toolbar"><button type="submit" class="more primary" data-fb-send>Send</button><button type="button" class="more" data-fb-close>Cancel</button></div>
    </form>`;
    dialog.querySelector("[data-fb-close]").onclick = () => dialog.close();
    dialog.showModal();
    dialog.querySelector("textarea").focus();
  }

  async function send(e) {
    e.preventDefault();
    const f = e.target, msg = dialog.querySelector("[data-fb-msg]"), btn = dialog.querySelector("[data-fb-send]");
    const message = f.message.value.trim();
    if (!message) { msg.textContent = "Write a message first."; return; }
    const withPage = f.withPage && f.withPage.checked;
    btn.disabled = true; msg.textContent = "Sending…";
    try {
      const res = await fetch(`${DH.sync.serviceUrl()}/v1/feedback`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, from: f.from.value, context: {
          page: withPage ? location.hash : "", league: withPage ? document.title : "", version: DH.version } }),
      });
      if (!res.ok) { let m = `HTTP ${res.status}`; try { m = (await res.json()).error || m; } catch (x) { /* not JSON */ } throw new Error(m); }
      dialog.querySelector("form").innerHTML = `<h2 id="fb-title">Thanks!</h2><p>Your feedback was sent.</p><div class="toolbar"><button type="button" class="more primary" data-fb-close>Close</button></div>`;
      dialog.querySelector("[data-fb-close]").onclick = () => dialog.close();
    } catch (err) {
      btn.disabled = false;
      msg.textContent = /Failed to fetch|NetworkError/.test(err.message) ? "Couldn't send it. Check your connection and try again." : err.message;
    }
  }

  document.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest("[data-feedback]")) { e.preventDefault(); open(); }
  });
  DH.feedback = { open };
})();
