// ads.js — consent-gated Google Ads + Meta Pixel loader.
//
// Behaviour:
//   • Reads the same consent key as analytics.js (localStorage['itsa_analytics_consent']).
//   • If consent === 'accepted', loads Google Ads (AW-17990502106) and, when
//     requested, Meta Pixel (804614302654633) with the events the page asked for.
//   • If consent is undecided or declined, loads nothing. If the user later
//     clicks Accept in the banner (via analytics.js), a custom 'itsa:consent-accepted'
//     event fires and this script loads the tags in-place — no page reload.
//
// Per-page configuration (optional; set BEFORE this script loads):
//   window.__itsaAdsDisableGoogleAds = true;      // skip Google Ads on this page
//   window.__itsaAdsMetaEvents = [                // fire these Meta Pixel events after init
//     { name: 'PageView' },
//     { name: 'Purchase', params: { value: 295.00, currency: 'GBP' } }
//   ];                                             // omit window.__itsaAdsMetaEvents entirely to skip Meta Pixel
(function () {
  'use strict';
  var GOOGLE_ADS_ID = 'AW-17990502106';
  var META_PIXEL_ID = '804614302654633';
  var CONSENT_KEY = 'itsa_analytics_consent';

  function loadGoogleAds() {
    if (window.__itsaGoogleAdsLoaded) return;
    window.__itsaGoogleAdsLoaded = true;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GOOGLE_ADS_ID;
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    function gtag() { dataLayer.push(arguments); }
    window.gtag = window.gtag || gtag;
    gtag('js', new Date());
    gtag('config', GOOGLE_ADS_ID);
  }

  function loadMetaPixel(events) {
    if (window.__itsaMetaPixelLoaded) return;
    window.__itsaMetaPixelLoaded = true;
    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0';
      n.queue = []; t = b.createElement(e); t.async = !0; t.src = v;
      s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', META_PIXEL_ID);
    (events || []).forEach(function (ev) {
      if (ev && ev.params) window.fbq('track', ev.name, ev.params);
      else if (ev && ev.name) window.fbq('track', ev.name);
    });
  }

  function loadAll() {
    if (!window.__itsaAdsDisableGoogleAds) loadGoogleAds();
    if (Array.isArray(window.__itsaAdsMetaEvents)) loadMetaPixel(window.__itsaAdsMetaEvents);
  }

  var choice;
  try { choice = localStorage.getItem(CONSENT_KEY); } catch (e) { choice = null; }
  if (choice === 'accepted') loadAll();

  // analytics.js dispatches this when the user clicks Accept in the banner.
  window.addEventListener('itsa:consent-accepted', loadAll);
})();
