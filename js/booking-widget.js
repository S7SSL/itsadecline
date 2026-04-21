// booking-widget.js
// Client-side booking widget for /booking.html. Renders a list of
// upcoming slots grouped by day, lets the borrower pick one, posts
// to the /book endpoint.
//
// Pure helpers (grouping, formatting) are exported for tests. DOM
// orchestration is kept thin and tested via the endpoint layer.

// -------------------------------------------------------------------
// Pure helpers
// -------------------------------------------------------------------

/** Group slots by UTC calendar day. Returns an array preserving order. */
export function groupSlotsByDay(slots) {
  const groups = new Map();
  for (const s of slots) {
    const key = s.startsAt.slice(0, 10); // YYYY-MM-DD
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  return [...groups.entries()].map(([date, items]) => ({ date, items }));
}

/** "09:30" (UTC) for display on the chip. */
export function formatSlotTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** "Mon 21 Apr" style header per day group. */
export function formatDayHeader(yyyyMmDd) {
  const d = new Date(yyyyMmDd + 'T00:00:00Z');
  if (isNaN(d.getTime())) return yyyyMmDd;
  const days   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

/** Turn sessionStorage / hidden-input JSON into a valuationSnapshot payload. */
export function extractValuationSnapshot(valuationResult, loanAmount) {
  if (!valuationResult) return null;
  return {
    postcode:       valuationResult.inputs?.postcode,
    propertyType:   valuationResult.inputs?.propertyType,
    estimatedValue: valuationResult.estimatedValue,
    loanAmount:     loanAmount ?? valuationResult.inputs?.loanAmount,
    ltv:            valuationResult.ltv?.ltv,
    ltvStatus:      valuationResult.ltv?.status,
  };
}

export function validateBorrower(b) {
  const errors = {};
  if (!b?.email || !/.+@.+\..+/.test(b.email)) errors.email = 'Please enter a valid email.';
  if (b?.phone && b.phone.replace(/\D/g, '').length < 7) errors.phone = 'Please enter a valid phone.';
  return { ok: Object.keys(errors).length === 0, errors };
}

// -------------------------------------------------------------------
// DOM wiring
// -------------------------------------------------------------------

const DEFAULT_SLOTS_ENDPOINT = '/api/slots';
const DEFAULT_BOOK_ENDPOINT  = '/api/bookings';

export function initBookingWidget(opts = {}) {
  if (typeof document === 'undefined') return;

  const root = document.querySelector(opts.root ?? '[data-booking-widget]');
  if (!root) return;

  const slotsUrl = opts.slotsUrl ?? window.SLOTS_ENDPOINT   ?? DEFAULT_SLOTS_ENDPOINT;
  const bookUrl  = opts.bookUrl  ?? window.BOOKING_ENDPOINT ?? DEFAULT_BOOK_ENDPOINT;
  const paidStatusUrl = opts.paidStatusUrl ?? window.PAID_STATUS_ENDPOINT ?? null;

  // Gate: if a leadId is in the URL, check the payment wall before
  // showing any slots. Unpaid leads get bounced to /application.html.
  const urlLeadId = new URL(window.location.href).searchParams.get('leadId');
  if (urlLeadId && paidStatusUrl) {
    gatePaymentThen(() => { /* continue to load() below */ });
    return;
  }

  async function gatePaymentThen(cb) {
    try {
      const r = await fetch(`${paidStatusUrl}?leadId=${encodeURIComponent(urlLeadId)}`);
      if (r.status === 404) {
        window.location.href = `/application.html?leadId=${encodeURIComponent(urlLeadId)}`;
        return;
      }
      const j = await r.json();
      if (!j?.paid) {
        window.location.href = `/application.html?leadId=${encodeURIComponent(urlLeadId)}`;
        return;
      }
      // Paid — continue with the normal init below.
      _continueInit();
    } catch {
      // Soft-fail to the unpaid state rather than let the user book
      // without a confirmed payment record.
      window.location.href = `/application.html?leadId=${encodeURIComponent(urlLeadId)}`;
    }
  }

  function _continueInit() { return init(); }
  return init();
  function init() {

  const els = {
    list:    root.querySelector('[data-slots]'),
    status:  root.querySelector('[data-status]'),
    confirm: root.querySelector('[data-confirmation]'),
    form:    root.querySelector('[data-book-form]'),
    errors:  root.querySelector('[data-book-errors]'),
  };

  let selectedSlot = null;
  let funders      = [];

  load();

  async function load() {
    setState('loading');
    try {
      const res  = await fetch(slotsUrl, { headers: { accept: 'application/json' } });
      const json = await res.json();
      funders = json.funders ?? [];
      render(json.slots ?? []);
      setState(json.slots?.length ? 'ok' : 'empty');
    } catch (e) {
      setState('error');
    }
  }

  function render(slots) {
    if (!els.list) return;
    els.list.innerHTML = '';
    const funderName = id => funders.find(f => f.id === id)?.name ?? 'Funder';

    for (const group of groupSlotsByDay(slots)) {
      const section = document.createElement('section');
      section.className = 'day';
      const h = document.createElement('h4');
      h.textContent = formatDayHeader(group.date);
      section.appendChild(h);
      const row = document.createElement('div');
      row.className = 'slot-row';
      for (const s of group.items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'slot-chip';
        b.textContent = `${formatSlotTime(s.startsAt)} · ${funderName(s.funderId)}`;
        b.dataset.startsAt     = s.startsAt;
        b.dataset.funderId     = s.funderId;
        b.dataset.durationMins = s.durationMins;
        b.addEventListener('click', () => selectSlot(s, b));
        row.appendChild(b);
      }
      section.appendChild(row);
      els.list.appendChild(section);
    }
  }

  function selectSlot(slot, btn) {
    selectedSlot = slot;
    els.list?.querySelectorAll('.slot-chip.selected')
      .forEach(n => n.classList.remove('selected'));
    btn.classList.add('selected');
    if (els.form) els.form.hidden = false;
  }

  els.form?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!selectedSlot) return;

    const fd = new FormData(els.form);
    const borrower = {
      name:  (fd.get('name')  ?? '').toString().trim() || undefined,
      email: (fd.get('email') ?? '').toString().trim(),
      phone: (fd.get('phone') ?? '').toString().trim() || undefined,
      notes: (fd.get('notes') ?? '').toString().trim() || undefined,
    };
    const check = validateBorrower(borrower);
    if (!check.ok) {
      if (els.errors) els.errors.textContent = Object.values(check.errors).join(' ');
      return;
    }

    const valuationResult = readValuationFromPage();
    const valuationSnapshot = extractValuationSnapshot(
      valuationResult, Number(fd.get('loanAmount')) || undefined);

    const body = {
      funderId:     selectedSlot.funderId,
      startsAt:     selectedSlot.startsAt,
      durationMins: selectedSlot.durationMins,
      borrower, valuationSnapshot,
      leadId:      fd.get('leadId')      || valuationResult?.leadId,
      valuationId: fd.get('valuationId') || valuationResult?.valuationId,
    };

    setState('submitting');
    try {
      const res = await fetch(bookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = json.error === 'already-booked'
          ? 'Sorry — that slot was just taken. Please pick another.'
          : 'We couldn\'t complete the booking. Please try again.';
        if (els.errors) els.errors.textContent = msg;
        setState('ok');
        if (json.error === 'already-booked') load();
        return;
      }
      if (els.confirm) {
        els.confirm.hidden = false;
        els.confirm.textContent =
          `Booked for ${formatDayHeader(selectedSlot.startsAt.slice(0,10))} ` +
          `at ${formatSlotTime(selectedSlot.startsAt)} UTC. ` +
          `A confirmation email is on its way to ${borrower.email}.`;
      }
      setState('booked');
    } catch {
      if (els.errors) els.errors.textContent = 'Network error — please try again.';
      setState('ok');
    }
  });

  function setState(s) {
    root.dataset.state = s;
    if (els.status) els.status.dataset.state = s;
  }
  }  // end init()
}

function readValuationFromPage() {
  try {
    const hidden = document.querySelector('input[name="valuationData"]');
    if (hidden?.value) return JSON.parse(hidden.value);
    const stored = sessionStorage.getItem('itsa.valuation');
    if (stored) return JSON.parse(stored);
  } catch {}
  return null;
}

// Auto-init unless embedded in a SPA that calls initBookingWidget() manually.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const auto = () => {
    if (document.querySelector('[data-booking-widget]')) initBookingWidget();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', auto);
  } else {
    auto();
  }
}
