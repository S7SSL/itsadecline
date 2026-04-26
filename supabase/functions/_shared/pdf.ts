// Builds a signed-record PDF from a signature image + proposal metadata.
// Uses pdf-lib (pure JS, runs fine on Deno Edge).
//
// Intentionally pragmatic: this is a clean signed record of what the client
// signed and when — not a pixel-perfect replica of the interactive HTML
// proposal. The email body links to the live proposal URL for full context.

import {
  PDFDocument,
  StandardFonts,
  rgb,
} from "https://esm.sh/pdf-lib@1.17.1";

export interface BuildPdfOptions {
  clientName: string;
  proposalName: string;
  proposalTitle?: string;     // human-readable title ("Financing Proposal — PPQ ...")
  proposalUrl?: string;       // link back to live proposal on itsadecline.com
  dateSigned: string;         // ISO yyyy-mm-dd
  clientEmail: string;
  signatureDataUrl: string;   // "data:image/png;base64,..."
  keyTerms?: Array<{ label: string; value: string }>;
}

export async function buildSignedProposalPdf(o: BuildPdfOptions): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${o.proposalTitle ?? o.proposalName} — Signed`);
  pdf.setAuthor("itsadecline.com");
  pdf.setSubject("Signed financing proposal");
  pdf.setProducer("itsadecline backend");
  pdf.setCreationDate(new Date());

  const page = pdf.addPage([595.28, 841.89]); // A4
  const { width, height } = page.getSize();
  const serif = await pdf.embedFont(StandardFonts.TimesRoman);
  const serifBold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const sans = await pdf.embedFont(StandardFonts.Helvetica);
  const sansBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const NAVY = rgb(0.10, 0.14, 0.20);
  const AMBER = rgb(0.96, 0.62, 0.04);
  const TEXT = rgb(0.12, 0.16, 0.22);
  const MUTED = rgb(0.42, 0.45, 0.50);
  const BORDER = rgb(0.90, 0.91, 0.92);

  // Header band
  const headerHeight = 80;
  page.drawRectangle({
    x: 0, y: height - headerHeight,
    width, height: headerHeight,
    color: NAVY,
  });
  page.drawText("itsadecline", {
    x: 48, y: height - 42,
    size: 20, font: sansBold, color: rgb(1, 1, 1),
  });
  page.drawText(".com", {
    x: 48 + sansBold.widthOfTextAtSize("itsadecline", 20), y: height - 42,
    size: 20, font: sansBold, color: AMBER,
  });
  page.drawText("SIGNED FINANCING PROPOSAL", {
    x: 48, y: height - 63,
    size: 9, font: sans, color: rgb(0.75, 0.78, 0.83),
  });

  // Body
  let y = height - headerHeight - 40;
  const leftX = 48;
  const rightLimit = width - 48;

  page.drawText(o.proposalTitle ?? o.proposalName, {
    x: leftX, y, size: 20, font: serifBold, color: NAVY,
  });
  y -= 30;

  // Metadata table
  const rows: Array<[string, string]> = [
    ["Client",     o.clientName],
    ["Reference",  o.proposalName],
    ["Email",      o.clientEmail],
    ["Signed on",  formatLongDate(o.dateSigned)],
  ];
  for (const [label, value] of rows) {
    page.drawText(label, { x: leftX, y, size: 10, font: sans, color: MUTED });
    page.drawText(value, { x: leftX + 110, y, size: 11, font: serif, color: TEXT });
    y -= 18;
  }

  y -= 12;
  drawRule(page, leftX, rightLimit, y, BORDER);
  y -= 24;

  // Key terms (optional)
  if (o.keyTerms && o.keyTerms.length) {
    page.drawText("Key terms", {
      x: leftX, y, size: 13, font: sansBold, color: NAVY,
    });
    y -= 20;
    for (const t of o.keyTerms) {
      page.drawText(t.label, { x: leftX, y, size: 10, font: sans, color: MUTED });
      page.drawText(t.value, {
        x: leftX + 160, y, size: 11, font: serif, color: TEXT,
        maxWidth: rightLimit - leftX - 160,
      });
      y -= 18;
    }
    y -= 12;
    drawRule(page, leftX, rightLimit, y, BORDER);
    y -= 24;
  }

  // Agreement statement
  const statement = [
    "The undersigned acknowledges reading the financing proposal referenced",
    "above, agrees to the indicative terms and next steps set out therein, and",
    "confirms their intent to proceed. This signed record, together with the",
    "interactive proposal available at itsadecline.com/proposal/, forms the",
    "complete signed document.",
  ];
  for (const line of statement) {
    page.drawText(line, { x: leftX, y, size: 11, font: serif, color: TEXT });
    y -= 16;
  }
  y -= 16;

  // Signature block
  page.drawText("Agreed and accepted", {
    x: leftX, y, size: 11, font: sansBold, color: NAVY,
  });
  y -= 18;

  // Embed signature image
  const sigBytes = dataUrlToBytes(o.signatureDataUrl);
  let sigImage;
  try {
    sigImage = await pdf.embedPng(sigBytes);
  } catch {
    sigImage = await pdf.embedJpg(sigBytes);
  }
  const sigMaxW = 220;
  const sigMaxH = 70;
  const dims = sigImage.scaleToFit(sigMaxW, sigMaxH);

  const sigX = leftX;
  const sigY = y - dims.height;
  page.drawImage(sigImage, {
    x: sigX,
    y: sigY,
    width: dims.width,
    height: dims.height,
  });
  // Signature line
  page.drawLine({
    start: { x: sigX, y: sigY - 4 },
    end:   { x: sigX + sigMaxW, y: sigY - 4 },
    thickness: 0.5, color: BORDER,
  });
  page.drawText("Signature", {
    x: sigX, y: sigY - 18, size: 9, font: sans, color: MUTED,
  });

  // Date block
  const dateX = leftX + sigMaxW + 40;
  page.drawText(formatLongDate(o.dateSigned), {
    x: dateX, y: sigY + 10, size: 12, font: serif, color: TEXT,
  });
  page.drawLine({
    start: { x: dateX, y: sigY - 4 },
    end:   { x: dateX + 160, y: sigY - 4 },
    thickness: 0.5, color: BORDER,
  });
  page.drawText("Date", {
    x: dateX, y: sigY - 18, size: 9, font: sans, color: MUTED,
  });

  // Footer
  const footerY = 40;
  drawRule(page, leftX, rightLimit, footerY + 18, BORDER);
  page.drawText("itsadecline.com  ·  Confidential", {
    x: leftX, y: footerY, size: 9, font: sans, color: MUTED,
  });
  const right = `${o.proposalName}  ·  ${formatLongDate(o.dateSigned)}`;
  const rightW = sans.widthOfTextAtSize(right, 9);
  page.drawText(right, {
    x: rightLimit - rightW, y: footerY, size: 9, font: sans, color: MUTED,
  });

  return await pdf.save();
}

function drawRule(page: any, x1: number, x2: number, y: number, color: any) {
  page.drawLine({
    start: { x: x1, y }, end: { x: x2, y },
    thickness: 0.5, color,
  });
}

function formatLongDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-GB", {
      day: "numeric", month: "long", year: "numeric",
    });
  } catch {
    return iso;
  }
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
