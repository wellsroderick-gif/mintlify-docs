(function () {
  function getSearchEntryButton() {
    var desktop = document.getElementById('search-bar-entry');
    if (desktop instanceof HTMLElement && desktop.offsetParent !== null) {
      return desktop;
    }
    var mobile = document.getElementById('search-bar-entry-mobile');
    if (mobile instanceof HTMLElement) {
      return mobile;
    }
    return desktop instanceof HTMLElement ? desktop : null;
  }

  function getAssistantEntryButton() {
    var desktop = document.getElementById('assistant-entry');
    if (desktop instanceof HTMLElement && desktop.offsetParent !== null) {
      return desktop;
    }
    var mobile = document.getElementById('assistant-entry-mobile');
    if (mobile instanceof HTMLElement && mobile.offsetParent !== null) {
      return mobile;
    }
    if (desktop instanceof HTMLElement) {
      return desktop;
    }
    var m = document.getElementById('assistant-entry-mobile');
    return m instanceof HTMLElement ? m : null;
  }

  function openSearch() {
    getSearchEntryButton()?.click();
  }

  function openAssistant() {
    getAssistantEntryButton()?.click();
  }

  function setNativeInputValue(input, value) {
    var desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (desc && desc.set) {
      desc.set.call(input, value);
    } else {
      input.value = value;
    }
  }

  function fillSearchInput(term) {
    var maxAttempts = 40;

    function tryFill(attempt) {
      var el = document.getElementById('search-input');
      if (el instanceof HTMLInputElement) {
        setNativeInputValue(el, term);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.focus();
        return;
      }
      if (attempt < maxAttempts) {
        window.setTimeout(function () {
          tryFill(attempt + 1);
        }, 50);
      }
    }

    window.requestAnimationFrame(function () {
      tryFill(0);
    });
  }

  document.addEventListener('click', function (e) {
    var target = e.target;
    if (!(target instanceof Element)) {
      return;
    }

    var trigger = target.closest('[data-search-trigger]');
    if (trigger) {
      e.preventDefault();
      openSearch();
      return;
    }

    var assistantTrigger = target.closest('[data-assistant-trigger]');
    if (assistantTrigger) {
      e.preventDefault();
      openAssistant();
      return;
    }

    var popular = target.closest('[data-popular-search]');
    if (popular) {
      e.preventDefault();
      var term = popular.getAttribute('data-term') || '';
      openSearch();
      if (term) {
        fillSearchInput(term);
      }
    }
  });
})();

/* ---------------------------------------------------------------------------
   WR-3657 - Door D homepage: the event-phase rail and the host/attendee switch.

   Ported from the design file's two page-level blocks. Their bodies are
   unchanged; only the wrapper differs. The design file's port note says to
   append at line 97, which is wrong - line 97 is a nested brace inside the
   delegated click handler above, and appending there would inject this code
   into that handler. It belongs after the handler's IIFE closes, which is here.

   The design blocks bound their listeners at script-execution time. This file
   is injected site-wide and runs before the page body is parsed, so a direct
   port would find no .wr-phase elements, hit its own early return
   and leave the rail inert - both on a cold load and on every client-side
   return to the homepage. boot() below waits for the rail and re-runs when a
   new one is mounted, which is why the delegated handler above exists too.
   --------------------------------------------------------------------------- */
(function () {
  function initPhaseSwitcher() {
    var tabs = Array.prototype.slice.call(document.querySelectorAll('.wr-phase'));
    if (!tabs.length) return;
    function select(tab) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        var p = document.getElementById(t.getAttribute('aria-controls'));
        if (p) p.hidden = !on;
      });
    }
    tabs.forEach(function (t) {
      t.addEventListener('click', function () { select(t); });
      t.addEventListener('keydown', function (e) {
        var i = tabs.indexOf(t);
        if (e.key === 'ArrowRight' && i < tabs.length - 1) { tabs[i + 1].focus(); select(tabs[i + 1]); }
        if (e.key === 'ArrowLeft' && i > 0) { tabs[i - 1].focus(); select(tabs[i - 1]); }
      });
    });
  }

  function initRoleSwitcher() {
    var setters = Array.prototype.slice.call(document.querySelectorAll('[data-role-set]'));
    var views = Array.prototype.slice.call(document.querySelectorAll('[data-role-view]'));
    var tabs = Array.prototype.slice.call(document.querySelectorAll('.wr-phase'));
    if (!setters.length) return;
    var role = 'host';
    function sync() {
      views.forEach(function (v) { v.hidden = v.getAttribute('data-role-view') !== role; });
      tabs.forEach(function (t, i) {
        t.setAttribute('aria-disabled', role === 'guest' && i === 1 ? 'true' : 'false');
        var id = t.getAttribute('aria-controls');
        var on = t.getAttribute('aria-selected') === 'true';
        var host = document.getElementById(id);
        var guest = document.getElementById(id.replace('wr-panel-', 'wr-gpanel-'));
        if (host) host.hidden = !on;
        if (guest) guest.hidden = !on;
      });
    }
    setters.forEach(function (b) {
      b.addEventListener('click', function () {
        role = b.getAttribute('data-role-set');
        setters.forEach(function (o) { o.setAttribute('aria-pressed', o === b ? 'true' : 'false'); });
        sync();
      });
    });
    tabs.forEach(function (t) { t.addEventListener('click', sync); });
    sync();
  }

  // Re-binding the same rail would double-fire every handler, so each rail
  // element is initialised once and remembered.
  var boundRail = null;
  var pending = false;

  function boot() {
    pending = false;
    var rail = document.querySelector('.wr-rail');
    if (!rail || rail === boundRail) {
      return;
    }
    boundRail = rail;
    // Source order matters: the phase handler's select() must run before the
    // role handler's sync() on the same click, or sync() reads a stale
    // aria-selected and shows the wrong panel.
    initPhaseSwitcher();
    initRoleSwitcher();
  }

  // Coalesce with a timer, not requestAnimationFrame. React swaps this whole
  // subtree after the first boot, so the rebind is not optional - and rAF does
  // not fire while the tab is backgrounded or otherwise not compositing, which
  // left the rail permanently inert. setTimeout still fires there.
  function schedule() {
    if (pending) {
      return;
    }
    pending = true;
    window.setTimeout(boot, 0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
