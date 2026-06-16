// Shared category taxonomy for the AI material import (Modul → Kategorie model).
// Single source of truth on the server; the client receives this list from the
// ingest init response, so there's no duplication to drift. Generic (CrashVault
// is a general Lern-Cockpit), adapted from BWL_Ult's fixed taxonomy.

"use strict";

const CATEGORIES = [
  { name: "Foliensatz",          desc: "Originale Vorlesungsfolien des Dozenten." },
  { name: "Mitschriften",        desc: "Live-Mitschriften aus der Vorlesung." },
  { name: "Cheatsheets",         desc: "Spickzettel / Formelsammlungen (oft in der Klausur erlaubt)." },
  { name: "Übungen",             desc: "Übungsblätter, Aufgaben, Labor, praktische Anwendungen." },
  { name: "Probeklausuren",      desc: "Alte Klausuren, Probeklausuren, typische Prüfungsaufgaben." },
  { name: "Klausurvorbereitung", desc: "Bewusst geordnete Zusammenfassungen / Lernzettel zur Vorbereitung." },
  { name: "Notizen",             desc: "Persönliche Notizen, schnelle Kritzeleien." },
  { name: "Quellen",             desc: "Sonstige Quellen: Skripte, Bücher, Links, Sonstiges." }
];

const NAMES = CATEGORIES.map(c => c.name);
const DEFAULT_CATEGORY = "Quellen";
const CONFIDENCE_THRESHOLD = parseFloat(process.env.INGEST_CONFIDENCE_THRESHOLD || "0.65");

function isValidCategory(name) { return NAMES.includes(name); }

module.exports = { CATEGORIES, NAMES, DEFAULT_CATEGORY, CONFIDENCE_THRESHOLD, isValidCategory };
