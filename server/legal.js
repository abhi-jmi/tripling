import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import { transaction } from "./db.js";
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function legalConfiguration(env = process.env) {
  const operator = (env.LEGAL_OPERATOR_NAME || "Tripling").trim();
  const contact = (env.LEGAL_CONTACT_EMAIL || "abhishek@tripling.in").trim();
  const jurisdiction = (env.LEGAL_JURISDICTION || "Chandigarh, India").trim();
  const published =
    !!operator &&
    operator.length <= 200 &&
    z.email().safeParse(contact).success &&
    !!jurisdiction &&
    jurisdiction.length <= 200;
  if (env.NODE_ENV === "production" && !published)
    throw new Error(
      "Production requires LEGAL_OPERATOR_NAME, LEGAL_CONTACT_EMAIL, and LEGAL_JURISDICTION before policies can be published.",
    );
  return {
    operator: operator || "Tripling — operator details pending",
    contact: contact || "Contact details pending",
    jurisdiction: jurisdiction || "Jurisdiction pending",
    region: env.AWS_REGION || "Local development; not deployed",
    published,
  };
}
export async function publishLegalDocuments(pool, env = process.env) {
  const config = legalConfiguration(env);
  const documents = [];
  for (const slug of ["terms", "privacy"]) {
    const template = JSON.parse(
      await readFile(new URL(`./legal/${slug}.json`, import.meta.url), "utf8"),
    );
    const replace = (value) =>
      value.replace(
        /\{\{(operator|contact|jurisdiction|region)\}\}/g,
        (_, key) => config[key],
      );
    const content = {
      introduction: template.introduction,
      sections: template.sections.map((s) => ({
        heading: s.heading,
        paragraphs: s.paragraphs.map(replace),
      })),
    };
    const hash = createHash("sha256")
      .update(JSON.stringify({ template, config }))
      .digest("hex");
    documents.push({
      ...template,
      content,
      version: `${template.version}-${hash}`,
    });
  }
  await transaction(pool, async (db) => {
    for (const doc of documents)
      await db.update(
        "legal_documents",
        { slug: doc.slug, version: doc.version },
        {
          $setOnInsert: {
            slug: doc.slug,
            version: doc.version,
            title: doc.title,
            content: doc.content,
            operator_name: config.operator,
            contact_email: config.contact,
            jurisdiction: config.jurisdiction,
            effective_on: doc.effectiveOn,
            published: config.published,
            created_at: new Date(),
          },
        },
        { upsert: true },
      );
  });
}
export async function currentLegalDocuments(db, { production = false } = {}) {
  const docs = await db.all(
    "legal_documents",
    production ? { published: true } : {},
    { sort: { slug: 1, published: -1, created_at: -1, version: -1 } },
  );
  const result = {};
  for (const doc of docs) if (!result[doc.slug]) result[doc.slug] = doc;
  return result;
}
export function legalMetadata(documents) {
  return Object.fromEntries(
    Object.entries(documents).map(([slug, d]) => [
      slug,
      {
        version: d.version,
        title: d.title,
        effectiveOn: d.effective_on,
        published: d.published,
        url: `/${slug}`,
      },
    ]),
  );
}
export function renderLegalPage(doc) {
  const sections = doc.content.sections
    .map(
      (section, index) =>
        `<section id="section-${index + 1}"><h2>${escape(section.heading)}</h2>${section.paragraphs.map((p) => `<p>${escape(p)}</p>`).join("")}</section>`,
    )
    .join("");
  const notice = doc.published
    ? ""
    : `<aside class="legal-draft" role="note"><strong>Draft policy</strong> — the operator’s public details are not configured. This document is not ready for public launch.</aside>`;
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="${doc.published ? "index,follow" : "noindex,nofollow"}"><title>${escape(doc.title)} — Tripling</title><link rel="stylesheet" href="/styles.css"></head><body class="legal-body"><a class="skip" href="#legal-content">Skip to policy</a><header class="legal-header"><a class="brand" href="/">tripling<span class="brand-dot">.</span></a><nav aria-label="Legal navigation"><a href="/terms" ${doc.slug === "terms" ? 'aria-current="page"' : ""}>Terms</a><a href="/privacy" ${doc.slug === "privacy" ? 'aria-current="page"' : ""}>Privacy</a><a href="/#discover">Explore trips ↗</a></nav></header><main id="legal-content" class="legal-content"><span class="eyebrow">YOUR JOURNEY. CLEAR EXPECTATIONS.</span><h1>${escape(doc.title)}</h1><p class="legal-version">Effective ${escape(doc.effective_on)} · Version ${escape(doc.version)}</p>${notice}<p class="legal-intro">${escape(doc.content.introduction)}</p><div class="legal-toc"><strong>On this page</strong>${doc.content.sections.map((s, i) => `<a href="#section-${i + 1}">${escape(s.heading)}</a>`).join("")}</div>${sections}<section class="legal-contact"><h2>Contact the operator</h2><p>${escape(doc.operator_name)} · ${escape(doc.jurisdiction)}</p><p>${doc.published ? `<a href="mailto:${escape(doc.contact_email)}">${escape(doc.contact_email)}</a>` : escape(doc.contact_email)}</p></section><a class="primary" href="/#discover">Back to Tripling</a></main><footer class="legal-footer"><a href="/terms">Terms and Conditions</a><a href="/privacy">Privacy Policy</a><span>Find your trip. Find your people.</span></footer></body></html>`;
}
