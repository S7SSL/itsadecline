// js/itsa-config.js
// Runtime config for the front-end. Exposed as window.ITSA_CONFIG so any
// page/script (booking-widget.js, form handlers on index.html, T&Cs page)
// can read the Supabase project URL + the 4 Edge Function endpoints
// without hardcoding them everywhere.
//
// Deliberately a plain <script> (not a module) so it works on GitHub Pages
// without a build step. Load it BEFORE any script that calls these URLs.

(function () {
  var SUPABASE_URL = 'https://uavjeywctezxcchoyboz.supabase.co';
  var FN_BASE     = SUPABASE_URL + '/functions/v1';

  window.ITSA_CONFIG = {
    SUPABASE_URL: SUPABASE_URL,
    ENDPOINTS: {
      LEAD_INTAKE:     FN_BASE + '/lead-intake',
      CREATE_CHECKOUT: FN_BASE + '/create-checkout',
      SLOTS:           FN_BASE + '/slots',
      BOOK:            FN_BASE + '/book'
    },
    // Surfaced to the booking widget / borrower UI
    SERVICE_FEE_GBP: 295,
    SUPPORT_EMAIL:   'hello@itsadecline.com'
  };
})();
