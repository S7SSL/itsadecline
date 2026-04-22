// analytics.js — GDPR-friendly consent banner + GA4 loader.
//
// Behaviour:
//   • First visit: shows a small bottom banner asking for consent. GA4 does
//     NOT load until the user clicks Accept. ads.js (Google Ads + Meta Pixel)
//     listens to the same consent state and behaves identically.
//   • After Accept: consent is stored in localStorage. GA4 loads on this and
//     every subsequent visit; a CustomEvent 'itsa:consent-accepted' is fired
//     so ads.js can load its tags in-place on the current page.
//   • After Decline: consent is stored as declined, banner does not reappear,
//     no analytics / ads tags load. A 'itsa:consent-declined' event fires so
//     other scripts can react.
//
// Measurement ID is the real GA4 ID from Google Analytics
// (Admin → Data Streams → Web → Measurement ID, format: G-XXXXXXXXXX).
(function () {
  'use strict';
  var MEASUREMENT_ID = 'G-7WWS29FMXD'; // itsadecline.com — GA4 property (property ID 504587566)
  var CONSENT_KEY = 'itsa_analytics_consent';

  function loadGA4() {
    if (!/^G-[A-Z0-9]+$/.test(MEASUREMENT_ID)) return; // placeholder — no-op
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + MEASUREMENT_ID;
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    function gtag() { dataLayer.push(arguments); }
    window.gtag = gtag;
    gtag('js', new Date());
    gtag('config', MEASUREMENT_ID, { anonymize_ip: true });
  }

  function showBanner() {
    if (document.getElementById('itsa-cookie-banner')) return;
    var b = document.createElement('div');
    b.id = 'itsa-cookie-banner';
    b.setAttribute('role', 'dialog');
    b.setAttribute('aria-label', 'Cookie consent');
    b.innerHTML =
      '<div style="max-width:1200px;margin:0 auto;display:flex;flex-wrap:wrap;align-items:center;gap:12px;justify-content:space-between;">' +
        '<p style="flex:1;min-width:240px;margin:0;font-size:14px;line-height:1.5;">' +
          'We use analytics and advertising cookies (Google Analytics, Google Ads, Meta Pixel) to understand how visitors use the site and to measure marketing. ' +
          'See our <a href="/privacy.html" style="color:#63b3ed;text-decoration:underline;">Privacy Policy</a>.' +
        '</p>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
          '<button type="button" id="itsa-consent-decline" style="background:transparent;color:#fff;border:1px solid #fff;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600;">Decline</button>' +
          '<button type="button" id="itsa-consent-accept" style="background:#3182ce;color:#fff;border:0;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600;">Accept</button>' +
        '</div>' +
      '</div>';
    b.style.cssText =
      'position:fixed;bottom:0;left:0;right:0;z-index:2147483000;' +
      'background:#1a2744;color:#fff;padding:14px 20px;' +
      'font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif;' +
      'box-shadow:0 -4px 20px rgba(0,0,0,.18);';
    document.body.appendChild(b);

    document.getElementById('itsa-consent-accept').addEventListener('click', function () {
      try { localStorage.setItem(CONSENT_KEY, 'accepted'); } catch (e) {}
      b.remove();
      loadGA4();
      // Signal other consent-gated scripts (ads.js) to load in-place.
      try { window.dispatchEvent(new CustomEvent('itsa:consent-accepted')); } catch (e) {}
    });
    document.getElementById('itsa-consent-decline').addEventListener('click', function () {
      try { localStorage.setItem(CONSENT_KEY, 'declined'); } catch (e) {}
      b.remove();
      try { window.dispatchEvent(new CustomEvent('itsa:consent-declined')); } catch (e) {}
    });
  }

  var choice;
  try { choice = localStorage.getItem(CONSENT_KEY); } catch (e) { choice = null; }

  if (choice === 'accepted') {
    loadGA4();
  } else if (choice !== 'declined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', showBanner);
    } else {
      showBanner();
    }
  }
})();
