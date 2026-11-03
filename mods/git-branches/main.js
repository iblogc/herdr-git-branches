// Branches: the current space's git branches, newest commit first (the one you
// are on stays on top), with ahead/behind and the working tree's +N −M.
// Click a branch you are not on to switch to it, after a dialog says what that
// means (nothing is written until you confirm). Clicking the current branch
// does nothing. The list follows the space you switch to.
//
//   where it first appears:  mods/git-branches/mod.json: { "place": "left", "size": 210 }
//   or where a layout wants it:
//     { "id": "branches", "type": "block", "size": { "px": 190 }, "content": { "mod": "git-branches" } }
//   a pane can name its folder:  pane.split { mod: "git-branches", props: { folder: "C:/repo" } }
//
// Freshness: a local repo is watched (the checkout and .git), so the list
// changes when git does; a remote one is asked every 4 seconds instead.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, props, spaces, theme, notify, openOverlay, closeOverlay, watchFolder } from "herdr";

// Reads write nothing under .git (no index refresh or lock, no fsmonitor
// cookie): the watch would see it, and every refresh would start the next one.
const GIT = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
// One line per branch: short name, "*" when it is HEAD, upstream, how far off it
// is ([ahead 1], [behind 2], [gone]), when it moved.
const FORMAT = "%(refname)%09%(HEAD)%09%(upstream:short)%09%(upstream:track)%09%(committerdate:relative)";

// A pane keeps props as typed, so a Windows folder's single backslashes make
// them invalid JSON; plain layouts hand over an object already.
function readProps() {
  const raw = props();
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw) ?? {};
  } catch {
    try {
      return JSON.parse(raw.replace(/\\/g, "\\\\")) ?? {};
    } catch {
      return {};
    }
  }
}

function base(path) {
  if (!path) return "";
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut < 0 ? path : path.slice(cut + 1);
}

// origin/some-long-feature -> some-long-feature
function shortUpstream(upstream) {
  const cut = upstream.indexOf("/");
  return cut < 0 ? upstream : upstream.slice(cut + 1);
}

// "[ahead 1, behind 2]" / "[gone]" -> { ahead, behind, gone }
function readTrack(track) {
  const t = { ahead: 0, behind: 0, gone: false };
  if (!track) return t;
  if (/\bgone\b/.test(track)) t.gone = true;
  const a = track.match(/ahead (\d+)/);
  const b = track.match(/behind (\d+)/);
  if (a) t.ahead = Number(a[1]);
  if (b) t.behind = Number(b[1]);
  return t;
}

function slug(name) {
  return name.replace(/[^A-Za-z0-9_-]/g, "-");
}

export default class Branches extends View {
  init(_props, cx) {
    const p = readProps();
    this.confirming = Boolean(p.confirm); // this copy is the "switch to it?" dialog
    this.done = false; // the dialog ran its checkout
    this.error = null;
    if (this.confirming) return;

    this.loading = false;
    this.again = false; // a change arrived while git was busy
    this.at = null; // what the list describes: "<machine>|<folder>"
    this.root = null; // the repository's root, or null when there is none
    this.gitDir = null; // this checkout's .git (HEAD, index)
    this.commonDir = null; // the repo's shared .git (refs, branches)
    this.hasHead = false;
    this.branches = []; // { name, current, upstream, track, when }
    this.changes = { files: 0, add: 0, del: 0 }; // the working tree, for the current branch
    this.detached = false;
    this.note = null; // why the list is empty
    this.fallback = false; // watching failed: ask on a timer instead
    this.watching = new Set();
    this.watchedKey = null;
    this.busy = null; // a branch being switched to

    this.refresh(cx);
    // Only a remote repo needs asking: a local one is watched below.
    cx.timer.every(4000, (cx) => {
      if (this.place()?.on || this.fallback || !this.root) this.refresh(cx);
    });
  }

  // Where to look: props.folder when a layout or a pane names one, else the
  // space on screen. git runs on that space's machine.
  place() {
    const p = readProps();
    if (p.folder) return { folder: p.folder, on: p.on ?? null };
    const s = spaces().find((s) => s.active) ?? spaces()[0];
    return s ? { folder: s.folder, on: s.machine } : null;
  }

  // What the list should describe right now.
  key() {
    const w = this.place();
    return w ? `${w.on ?? ""}|${w.folder}` : null;
  }

  refresh(cx) {
    if (this.loading) {
      this.again = true; // one refresh follows this one
      return;
    }
    const w = this.place();
    const key = this.key();
    if (key !== this.at) {
      this.at = key;
      this.busy = null;
    }
    if (!w) {
      this.root = null;
      this.branches = [];
      this.note = "No space";
      return;
    }
    this.loading = true;
    this.again = false;
    const at = this.at;
    cx.spawn(async (cx) => {
      const git = (args, cwd) => exec("git", [...GIT, ...args], { cwd, on: w.on });
      try {
        const top = await git(["rev-parse", "--show-toplevel"], w.folder);
        if (top.code !== 0) {
          this.root = null;
          this.branches = [];
          this.note = "Not a git repo";
          return;
        }
        this.root = top.stdout.trim();
        // A linked worktree's HEAD and index live in its own .git, refs in the shared one.
        const own = await git(["rev-parse", "--path-format=absolute", "--absolute-git-dir"], this.root);
        const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], this.root);
        this.gitDir = own.code === 0 ? own.stdout.trim() : null;
        this.commonDir = common.code === 0 ? common.stdout.trim() : null;

        const heads = await git(
          // Local branches, and the remote ones not checked out: a fresh clone
          // otherwise shows one row and no way to switch.
          ["for-each-ref", "--sort=-committerdate", `--format=${FORMAT}`, "refs/heads", "refs/remotes"],
          this.root,
        );
        if (heads.code !== 0) {
          this.branches = [];
          this.note = "git failed";
          return;
        }
        const rows = heads.stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [ref, head, upstream, track, when] = line.split("\t");
            // refs/remotes/origin/HEAD is a symref, not a branch.
            if (ref.endsWith("/HEAD")) return null;
            if (ref.startsWith("refs/remotes/")) {
              // refs/remotes/origin/main -> main, checked out as "main" (git DWIM)
              const short = ref.slice("refs/remotes/".length).replace(/^[^/]+\//, "");
              return { name: short, ref, current: false, remote: true, upstream: null, track: readTrack(track), when: when || "" };
            }
            return {
              name: ref.slice("refs/heads/".length),
              ref,
              current: head === "*",
              remote: false,
              upstream: upstream || null,
              track: readTrack(track),
              when: when || "",
            };
          })
          // Drop the skipped refs/.../HEAD rows before anything reads a field.
          .filter(Boolean)
          // A remote branch with a local twin is not a second row: the local one
          // already shows how far off it is.
          .filter((b, _i, all) => !(b.remote && all.some((o) => !o.remote && o.name === b.name)));
        // The branch you are on goes on top; the rest keep git's newest-first order.
        rows.sort((a, b) => Number(b.current) - Number(a.current) || Number(a.remote) - Number(b.remote));
        this.branches = rows;

        // The working tree: which branch, how far off its upstream, what changed.
        const status = await git(
          ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"],
          this.root,
        );
        if (status.code === 0) {
          let files = 0;
          for (const line of status.stdout.split("\n")) {
            if (/^[12u?] /.test(line)) files += 1;
            else if (line.startsWith("# branch.head ")) {
              const head = line.slice(14).trim();
              this.detached = head === "(detached)";
            }
          }
          this.changes = { files, add: 0, del: 0 };
        }
        const head = await git(["rev-parse", "--verify", "HEAD"], this.root);
        this.hasHead = head.code === 0;
        if (this.hasHead) {
          // Lines added and removed, from HEAD to the working tree (staged included).
          const numstat = await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"], this.root);
          if (numstat.code === 0) {
            let add = 0;
            let del = 0;
            for (const entry of numstat.stdout.split("\0")) {
              if (!entry) continue;
              const [a, d] = entry.split("\t");
              add += Number(a) || 0; // "-" for a binary file
              del += Number(d) || 0;
            }
            this.changes.add = add;
            this.changes.del = del;
          }
        }
        this.note = rows.length ? null : "No branches yet";
        if (!w.on) this.watch(cx);
      } catch (e) {
        this.root = null;
        this.branches = [];
        this.note = "git not found";
      } finally {
        this.loading = false;
        // The space changed while git ran: these rows describe the old one.
        if (this.at === at) cx.notify();
        if (this.again) this.refresh(cx);
      }
    });
  }

  // Watch a local repo: the checkout for file edits, .git for branches and
  // checkouts (Linux skips .git, so it is watched on its own there too).
  watch(cx) {
    const key = this.at;
    if (this.watchedKey === key) return;
    this.watchedKey = key;
    for (const dir of [this.root, this.gitDir, this.commonDir]) {
      if (!dir || this.watching.has(dir)) continue;
      this.watching.add(dir);
      cx.spawn(async (cx) => {
        try {
          while (this.watching.has(dir) && this.at === key) {
            await watchFolder(dir);
            if (this.at === key) this.refresh(cx);
          }
        } catch {
          this.fallback = true; // too big a tree, or no watch here: ask on a timer
        } finally {
          this.watching.delete(dir);
        }
      });
    }
  }

  // A branch you are not on: say what switching means, then do it if confirmed.
  async propose(b, cx) {
    const w = this.place();
    if (!w || this.busy) return;
    this.busy = b.name;
    cx.notify();
    let last = { code: 1, stdout: "" };
    try {
      last = await exec("git", [...GIT, "log", "-1", "--format=%h %s", b.ref ?? b.name], {
        cwd: this.root ?? w.folder,
        on: w.on,
      });
    } catch (e) {
      // A machine away, or git gone: say so rather than doing nothing.
      notify({ title: "Cannot read that branch", body: String(e).slice(0, 160), level: "blocked" });
    } finally {
      // Always let go: a stuck `busy` would swallow every later click.
      this.busy = null;
      cx.notify();
    }
    openOverlay({
      mod: "git-branches",
      kind: "dialog",
      width: 430,
      props: {
        confirm: b.name,
        repo: base(this.root ?? w.folder),
        root: this.root ?? w.folder,
        on: w.on,
        commit: last.code === 0 ? last.stdout.trim() : null,
        remote: Boolean(b.remote),
        dirty: this.changes.files,
      },
    });
  }

  // The dialog's own work: the checkout.
  async confirmCheckout(cx) {
    if (this.done) return;
    const p = readProps();
    this.done = true;
    this.error = null;
    cx.notify();
    const r = await exec("git", [...GIT, "checkout", p.confirm], { cwd: p.root, on: p.on });
    if (r.code === 0) {
      closeOverlay(p.overlay);
      notify({ title: "Branch switched", body: `${p.confirm} · ${p.repo}`, level: "done" });
    } else {
      this.done = false;
      this.error = (r.stderr || r.stdout || "git checkout failed").trim().split("\n")[0];
      cx.notify();
    }
  }

  // A local branch, or the one you are on.
  row(t, b, cx) {
    const current = b.current;
    const busy = this.busy === b.name;
    const { ahead, behind, gone } = b.track;
    return h_flex()
      .id(`branch-${slug(b.name)}`)
      .flex_none()
      .h(26)
      .px(7)
      .gap(6)
      .items_center()
      .rounded(6)
      .when(current, (el) => el.bg(t.selected))
      .when(!current, (el) => el.hover((s) => s.bg(t.hover)))
      .cursor_pointer()
      .on_click((_e, cx) => {
        // The click's cx is spent once this handler returns: propose awaits git,
        // so it needs a cx of its own (AGENTS.md: never keep a cx and use it later).
        if (!current) cx.spawn(async (cx) => this.propose(b, cx));
      })
      .child(div().w(6).h(6).flex_none().rounded(3).bg(current ? t.accent : t.border))
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_size(12.5)
          .text_color(current ? t.foreground : t.muted)
          .when(current, (el) => el.font_semibold())
          .child(b.name),
      )
      // How far off its upstream: ahead in green, behind in red, gone in dim.
      .when(ahead > 0, (el) => el.child(div().flex_none().text_size(9.5).text_color(t.ansi2).child(`↑${ahead}`)))
      .when(behind > 0, (el) => el.child(div().flex_none().text_size(9.5).text_color(t.ansi1).child(`↓${behind}`)))
      .when(gone, (el) => el.child(div().flex_none().text_size(9.5).text_color(t.dim).child("gone")))
      // The working tree belongs to the branch you are on.
      .when(current && this.changes.files > 0, (el) =>
        el
          .child(div().flex_none().text_size(9.5).text_color(t.dim).child(`${this.changes.files}f`))
          .when(this.changes.add > 0, (el) =>
            el.child(div().flex_none().text_size(9.5).text_color(t.ansi2).child(`+${this.changes.add}`)),
          )
          .when(this.changes.del > 0, (el) =>
            el.child(div().flex_none().text_size(9.5).text_color(t.ansi1).child(`−${this.changes.del}`)),
          ),
      )
      .when(busy, (el) =>
        el.child(svg("mods/git-branches/spinner.svg").size(10).flex_none().text_color(t.dim).spin(900)),
      )
      .when(b.remote, (el) => el.child(div().flex_none().text_size(9).text_color(t.dim).child("remote")))
      .when(!current && !busy, (el) =>
        el.child(div().flex_none().text_size(9.5).text_color(t.dim).child(b.when)),
      );
  }

  head(t) {
    const { add, del, files } = this.changes;
    return h_flex()
      .flex_none()
      .h(27)
      .px(8)
      .gap(6)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(svg("mods/git-branches/git-branch.svg").size(12).flex_none().text_color(t.muted))
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_size(11.5)
          .font_semibold()
          .text_color(t.muted)
          .child(this.root ? base(this.root) : "Branches"),
      )
      .when(files > 0, (el) => el.child(div().flex_none().text_size(9.5).text_color(t.dim).child(`${files}f`)))
      .when(add > 0, (el) => el.child(div().flex_none().text_size(9.5).text_color(t.ansi2).child(`+${add}`)))
      .when(del > 0, (el) => el.child(div().flex_none().text_size(9.5).text_color(t.ansi1).child(`−${del}`)))
      .when(this.loading, (el) =>
        el.child(svg("mods/git-branches/spinner.svg").size(11).flex_none().text_color(t.dim).spin(900)),
      )
      .child(div().flex_none().text_size(10).text_color(t.dim).child(String(this.branches.length)));
  }

  // The "switch to it?" dialog: one more copy of this mod, with props.confirm.
  dialog(cx) {
    const t = theme();
    const p = readProps();
    const button = (id, label, bg, fg, onClick) =>
      h_flex()
        .id(id)
        .h(30)
        .px(13)
        .items_center()
        .rounded(7)
        .border_1()
        .border_color(id === "no" ? t.input : bg)
        .bg(bg)
        .text_color(fg)
        .cursor_pointer()
        .hover((s) => s.opacity(0.88))
        .on_click(onClick)
        .child(label);
    return v_flex()
      .id("branch-confirm")
      .size_full()
      .min_h(0)
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(12.5)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(svg("mods/git-branches/git-branch.svg").size(13).flex_none().text_color(t.muted))
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(14)
              .font_semibold()
              .text_color(t.foreground)
              .child(`Switch to "${p.confirm}"?`),
          )
          .child(div().flex_none().text_size(10).text_color(t.dim).child("Esc")),
      )
      .child(div().truncate().text_size(11).text_color(t.dim).child(p.repo ?? ""))
      .child(div().truncate().text_size(11).text_color(t.muted).child(p.commit ?? "No commits yet"))
      .child(
        div()
          .text_size(11)
          .text_color(p.dirty > 0 ? t.blocked : t.dim)
          .child(
            p.dirty > 0
              ? `${p.dirty} uncommitted file(s) here: git keeps them only when nothing conflicts.`
              : "Nothing uncommitted: the checkout is clean.",
          ),
      )
      .when(p.remote, (el) =>
        el.child(div().text_size(11).text_color(t.dim).child("No local branch yet: this makes one that tracks it.")),
      )
      .when(Boolean(this.error), (el) => el.child(div().text_size(11).text_color(t.blocked).child(this.error)))
      .child(
        h_flex()
          .justify_end()
          .gap(8)
          .child(button("no", "Cancel", t.raised, t.foreground, () => closeOverlay(p.overlay)))
          .child(button("yes", "Checkout", t.solid, t.solid_foreground, (_e, cx) => this.confirmCheckout(cx))),
      );
  }

  render(cx) {
    if (this.confirming) return this.dialog(cx);
    // The copy can be made before the spaces are known, and a space switch is
    // live data, not a timer: ask again whenever what we describe changes.
    if (this.key() !== this.at) this.refresh(cx);
    const t = theme();
    const empty = div()
      .p(10)
      .text_size(11.5)
      .text_color(t.dim)
      .child(this.note ?? "");
    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .child(this.head(t))
      .child(
        v_flex()
          .id("branch-list")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .p(4)
          .gap(1)
          .children(this.branches.length ? this.branches.map((b) => this.row(t, b, cx)) : [empty]),
      )
      .when(this.detached, (el) =>
        el.child(div().flex_none().px(8).py(4).text_size(10).text_color(t.dim).child("Detached HEAD")),
      );
  }
}
