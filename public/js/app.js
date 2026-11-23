// Small progressive enhancements shared by every page. Everything still works without JavaScript.
(function () {
  'use strict';

  // <form data-confirm="Are you sure?"> asks before submitting (no inline handlers: strict CSP).
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    var message = form.getAttribute('data-confirm');
    if (message && !window.confirm(message)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    // Stop double submits (e.g. tapping Register twice on a slow connection).
    if (form.method.toLowerCase() === 'post' && !form.hasAttribute('data-allow-resubmit')) {
      if (form.dataset.submitting === '1') {
        event.preventDefault();
        return;
      }
      setTimeout(function () {
        if (!event.defaultPrevented) form.dataset.submitting = '1';
      }, 0);
    }
  }, true);

  // Re-enable forms when a page is restored from the back/forward cache.
  window.addEventListener('pageshow', function () {
    document.querySelectorAll('form[data-submitting]').forEach(function (f) { delete f.dataset.submitting; });
  });
})();
