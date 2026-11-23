/* HQ admin: undo tools for when something went wrong mid-count - delete one count, stop / resume a warehouse's
   daily count, stop & reset a monthly stock take. Every one asks first; photos of deleted counts are removed too. */
import { S } from "./state.js";
import { rpc, fn } from "./api.js";
import { el, tsTxt, msg, confirmBox, openModal, closeModal, errText, toast } from "./ui.js";
import { hasQty, sessRole } from "./pure.js";

function tok() { return S.admin.token; }
async function dropPhotos(paths) { if (paths && paths.length) { try { await fn("photos", { action: "remove_paths", token: tok(), paths: paths }); } catch (e) { } } }
function linesOf(d) { var L = d.lines || {}; return Object.keys(L).filter(function (k) { return hasQty(L[k]); }).length; }
function roleTxt(d) { var r = sessRole(d); return r === "fin" ? "Finance" : r === "ops" ? "Ops" : "Count"; }

/* docs: counts as docsFrom() gives them. onDone() after a delete. */
export function deleteCountsModal(title, docs, onDone) {
  openModal(function (sh) {
    sh.append(el("h3", { text: "Delete a count · " + title }),
      el("p", { class: "small muted", text: "Use this when a count went wrong (a bug, the wrong warehouse). The count and its photos are deleted; the team starts that count again from zero." }));
    if (!docs.length) sh.append(el("p", { class: "muted", text: "No counts yet." }));
    docs.forEach(function (d) {
      sh.append(el("div", { class: "issue", style: "align-items:center" },
        el("div", {}, el("b", { text: roleTxt(d) + " · " + (d.member || "-") }),
          el("div", { class: "small muted", text: (d.status === "submitted" ? "Submitted " + tsTxt(d.submittedAt) : "Counting") + " · " + linesOf(d) + " line(s) · " + (d.photos || 0) + " photo(s)" })),
        el("button", { class: "btn", style: "color:var(--bad);min-height:38px;padding:6px 12px", text: "Delete", onclick: function () {
          closeModal();
          confirmBox("Delete this count?", roleTxt(d) + " · " + (d.member || "-") + " · " + linesOf(d) + " line(s)\n\nThe count and its photos are deleted for good. The team has to count again. This can't be undone.", "Delete", async function () {
            try { var r = await rpc("admin_delete_session", { p_token: tok(), p_session: d.id }); await dropPhotos(r.paths); toast("Count deleted"); onDone && onDone(); }
            catch (e) { msg("Can't delete", errText(e)); }
          });
        } })));
    });
    sh.append(el("button", { class: "btn block", style: "margin-top:12px", text: "Close", onclick: closeModal }));
  });
}

/* today's daily count of one warehouse: stop (list + counts deleted, day left out of KPI001) or resume (fresh list) */
export function stopDaily(branch, stop, onDone) {
  confirmBox(stop ? "Stop today's count at " + branch + "?" : "Resume today's count at " + branch + "?",
    stop ? "Today's list and every count on it are deleted (photos too). The warehouse sees “HQ stopped today's count”, and the day doesn't count in KPI001.\n\nYou can resume later: that makes a fresh list and the team counts from zero."
      : "The warehouse gets today's list again and can count from zero.",
    stop ? "Stop count" : "Resume", async function () {
      try { var r = await rpc("admin_stop_daily", { p_token: tok(), p_branch: branch, p_stop: stop }); await dropPhotos(r.paths); toast(stop ? branch + ": today's count stopped" : branch + ": count resumed"); onDone && onDone(); }
      catch (e) { msg("Can't " + (stop ? "stop" : "resume"), errText(e)); }
    });
}

/* the open monthly stock take: every count deleted, back to Draft. The name must be typed to confirm. */
export function resetTake(t, onDone) {
  openModal(function (sh) {
    var i = el("input", { type: "text", placeholder: t.name, autocomplete: "off", "aria-label": "Type the stock take name" }), err = el("div", { class: "small badt", style: "min-height:18px;margin-top:6px" });
    var go = el("button", { class: "btn primary", style: "flex:2;background:var(--bad);border-color:var(--bad)", text: "Stop & reset", disabled: true, onclick: async function () {
      go.disabled = true;
      try { var r = await rpc("admin_reset_take", { p_token: tok(), p_confirm: i.value }); await dropPhotos(r.paths); closeModal(); toast("Stock take reset · " + r.sessions + " count(s) deleted"); onDone && onDone(); }
      catch (e) { err.textContent = errText(e); go.disabled = false; }
    } });
    i.addEventListener("input", function () { go.disabled = i.value.trim() !== String(t.name).trim(); });
    sh.append(el("h3", { style: "color:var(--bad)", text: "Stop & reset this stock take?" }),
      el("p", { class: "muted", style: "white-space:pre-line", text: "Counting stops at every warehouse and EVERY count in “" + t.name + "” is deleted (Ops and Finance, photos, recount lists). The stock take goes back to Draft: the name, SKUs and MB52 stay, so you can open counting again.\n\nThis can't be undone. Type the stock take name to confirm:" }),
      i, err, el("div", { class: "row", style: "margin-top:12px" }, el("button", { class: "btn", style: "flex:1", text: "Cancel", onclick: closeModal }), go));
    setTimeout(function () { i.focus(); }, 100);
  });
}
