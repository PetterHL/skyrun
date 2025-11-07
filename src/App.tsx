import React, { useEffect, useMemo, useRef, useState } from "react";
import { Upload, Download, Trash2, FileDown, Search, Settings, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

/**
 * Mobile-first, offline-capable training log (tailored for you)
 * - Sync: GitHub Gist ONLY (token + gistId), with pull/push + validation
 * - Plan is generated on button (locked start/target)
 * - Week/Block grouping, collapsible, today tint, completion visuals
 * - Detailed daily instructions tab
 * - Plan editor: cap active sessions per week from date (keeps 5 by default)
 * - Phased program: Fase 1 (Grunnlag), Fase 2 (Utvikling), Fase 3 (Spissing)
 */

// ---------------- Types & Schema ----------------
const SCHEMA_VERSION = 5 as const;

type PlannedType = "Lett" | "Intervall" | "Styrke" | "Moderat" | "Langtur";

type GoalType = "minutes" | "km";

interface Entry {
  id: string;
  date: string; // ISO YYYY-MM-DD
  plannedType: PlannedType;
  plannedMinutes?: number;
  plannedKm?: number;
  focus?: string;
  instructions?: string; // detaljert øktbeskrivelse
  completed?: boolean;
  actualMinutes?: number;
  actualKm?: number;
  rpe?: number; // 1-10
  notes?: string;
  block?: string; // Fase navn
  active?: boolean; // om økten er aktiv i planen
  updatedAt: number; // epoch ms for merge
}

interface PersistedDoc {
  version: number;
  entries: Entry[];
}

interface AppSettings {
  goalType: GoalType;
  goalValue: number; // per week
  autoPull: boolean;
  pullIntervalSec: number;
}

// ---------------- Utils ----------------
function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function nowMs() { return Date.now(); }

function formatMinutes(m: number | undefined) {
  if (!m && m !== 0) return "-";
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60).toString().padStart(2, "0");
  return h > 0 ? `${h}:${mm} t` : `${Math.round(m)} min`;
}

function weekKey(d: Date) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function addDays(iso: string, days: number) {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function mondayOrNext(iso: string) {
  const d = new Date(iso + "T12:00:00");
  const day = d.getDay(); // 1=Mon, 0=Sun
  const offset = day === 1 ? 0 : (8 - (day === 0 ? 7 : day)) % 7;
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

function todayISO() { const d = new Date(); const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,'0'); const da=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${da}`; }
function cmpISO(a: string, b: string) { return a.localeCompare(b); }

// Next Skyrun race date (Aug 1) relative to *today* – ensures target is in the future
function nextSkyrunDate(): string {
  const now = new Date();
  let y = now.getFullYear();
  const targetThisYear = new Date(Date.UTC(y, 7, 1)); // month is 0-based (7 = August)
  if (now.getTime() > targetThisYear.getTime()) y += 1; // if past Aug 1, use next year
  const m = String(8).padStart(2, '0'); // "08"
  return `${y}-${m}-01`;
}

function toCSV(entries: Entry[]) {
  const header = ["date","plannedType","plannedMinutes","plannedKm","focus","instructions","completed","actualMinutes","actualKm","rpe","notes","block","active","updatedAt"]; 
  const rows = entries.map((e) => [ e.date, e.plannedType, e.plannedMinutes ?? "", e.plannedKm ?? "", (e.focus ?? "").replace(/\n/g, " "), (e.instructions ?? "").replace(/\n/g, " "), e.completed ? "1" : "0", e.actualMinutes ?? "", e.actualKm ?? "", e.rpe ?? "", (e.notes ?? "").replace(/\n/g, " "), e.block ?? "", e.active===false?"0":"1", e.updatedAt ]);
  return [header.join(","), ...rows.map((r) => r.join(","))].join("\n");
}

function download(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
}

// --------------- Templates ---------------
// NOTE: Fase 1 (eksisterende), Fase 2 (Utvikling), Fase 3 (Spissing). Alle i samme format.

type TemplateItem = { type: PlannedType; minutes?: number; km?: number; focus?: string; instructions?: string };

// FASE 1 – Grunnlag (uke 1–8) – eksisterte fra før, beholdt som PHASE1
const TEMPLATE_WEEKS_PHASE1: Array<Array<TemplateItem>> = [
  [
    { type: "Lett", minutes: 30, focus: "Positur + core etterpå", instructions: "Rolig sone 1–2. 3×20 s teknikkdrag. Kjerne 6–8 min." },
    { type: "Intervall", minutes: 30, focus: "6×2 min, kort pause", instructions: "Oppv 10. 6×2 min sone 3–4, 60 s jogg. Nedjogg 5–10." },
    { type: "Styrke", minutes: 25, focus: "Bein/kjerne", instructions: "2 runder: Bulgarsk utfall, hip thrust, tåhev, Pallof, sideplanke." },
    { type: "Moderat", minutes: 40, focus: "Jevn rytme", instructions: "Sone 2–3, 4×20 s stigninger." },
    { type: "Langtur", minutes: 50, focus: "Rolig, siste 5 min raskere", instructions: "Rolig sone 1–2. 5 min sone 3 på slutten." }
  ],
  [
    { type: "Lett", minutes: 30, focus: "Positur + core", instructions: "Rolig sone 1–2. 3×30 s poseløft. Kjerne 6–8 min." },
    { type: "Intervall", minutes: 32, focus: "6×2 min, kortere pauser", instructions: "Oppv 10. 6×2 min sone 3–4, 45 s jogg. Nedjogg." },
    { type: "Styrke", minutes: 25, focus: "Stabilitet", instructions: "2 runder: step-up, ettbeins markløft (lett), tåhev, hollow hold." },
    { type: "Moderat", minutes: 40 },
    { type: "Langtur", minutes: 55 }
  ],
  [
    { type: "Lett", minutes: 35, focus: "Positur + core", instructions: "Rolig. 4×20 s frekvens 180+. Kjerne 8–10 min." },
    { type: "Intervall", minutes: 35, focus: "5×3 min", instructions: "Oppv 10. 5×3 min sone 3–4, 90 s jogg. Nedjogg 8." },
    { type: "Styrke", minutes: 30 },
    { type: "Moderat", minutes: 45, focus: "Siste 10 min raskere", instructions: "35 min sone 2 + 10 min sone 3." },
    { type: "Langtur", minutes: 60 }
  ],
  [
    { type: "Lett", minutes: 35 },
    { type: "Intervall", minutes: 36, focus: "5×3 min", instructions: "Som uke 3, hold kontroll." },
    { type: "Styrke", minutes: 30 },
    { type: "Moderat", minutes: 45 },
    { type: "Langtur", minutes: 70 }
  ],
  [
    { type: "Lett", minutes: 40, focus: "Positur + core", instructions: "Rolig. 6×15 s stigninger. Lett kjerne." },
    { type: "Intervall", minutes: 40, focus: "4×5 min", instructions: "Oppv 12. 4×5 sone 3, 2 min jogg." },
    { type: "Styrke", minutes: 30, focus: "Bein + legg", instructions: "3 runder: knebøy, hip thrust, tåhev, farmer carry." },
    { type: "Moderat", minutes: 50 },
    { type: "Langtur", minutes: 75 }
  ],
  [
    { type: "Lett", minutes: 40 },
    { type: "Intervall", minutes: 42, focus: "4×5 min, kortere pauser", instructions: "Oppv 12. 4×5 sone 3, 90 s jogg." },
    { type: "Styrke", minutes: 30 },
    { type: "Moderat", minutes: 50 },
    { type: "Langtur", minutes: 80 }
  ],
  [
    { type: "Lett", minutes: 40 },
    { type: "Intervall", minutes: 44, focus: "3×8 min (2 min pause)", instructions: "Oppv 12. 3×8 sone 3, 2 min jogg. Nedjogg 10." },
    { type: "Styrke", minutes: 30 },
    { type: "Moderat", minutes: 50, focus: "Litt fart i midten", instructions: "15 min sone 2 + 15 min sone 3 + 20 min rolig." },
    { type: "Langtur", minutes: 85 }
  ],
  [
    { type: "Lett", minutes: 40 },
    { type: "Intervall", minutes: 40, focus: "20 min tempo jevnt", instructions: "Oppv 15. 20 min øvre sone 3. Nedjogg 5–10." },
    { type: "Styrke", minutes: 30 },
    { type: "Moderat", minutes: 55 },
    { type: "Langtur", minutes: 90 }
  ]
];

// FASE 2 – Utvikling (uke 9–16)
const TEMPLATE_WEEKS_PHASE2: Array<Array<TemplateItem>> = [
  [
    { type: "Lett", minutes: 35, focus: "Positur + core", instructions: "Rolig sone 1–2. 3×20 s teknikk. Core 8–10 min." },
    { type: "Intervall", minutes: 40, focus: "10×1 min bakke", instructions: "Oppv 12. 10×1 min stigning 4–6%, jogg ned. Nedjogg 8." },
    { type: "Styrke", minutes: 25, focus: "Hofte/legg", instructions: "3 runder: ettbeins markløft, utfall bak, tåhev, planke." },
    { type: "Moderat", minutes: 50, focus: "Terskellek", instructions: "2×10 min sone 3 (2 min jogg) i jevn fart." },
    { type: "Langtur", minutes: 90, focus: "Rolig + siste 5 min raskere" }
  ],
  [
    { type: "Lett", minutes: 35 },
    { type: "Intervall", minutes: 42, focus: "6×3 min bakke", instructions: "Oppv 12. 6×3 min sone 3–4, jogg ned. Nedjogg." },
    { type: "Styrke", minutes: 25 },
    { type: "Moderat", minutes: 50 },
    { type: "Langtur", minutes: 95 }
  ],
  [
    { type: "Lett", minutes: 40, focus: "Teknikk + frekvens", instructions: "4×20 s frekvensøkning til 180+. Lett kjerne." },
    { type: "Intervall", minutes: 45, focus: "5×4 min bakke", instructions: "Oppv 12. 5×4 min s3–4, 2 min jogg. Nedjogg." },
    { type: "Styrke", minutes: 30 },
    { type: "Moderat", minutes: 55, focus: "Progressiv", instructions: "S2→S3 siste 15 min raskere." },
    { type: "Langtur", minutes: 100 }
  ],
  [
    { type: "Lett", minutes: 40 },
    { type: "Intervall", minutes: 45, focus: "4×5 min tempo flatt", instructions: "Oppv 12. 4×5 min s3, 90 s jogg." },
    { type: "Styrke", minutes: 30 },
    { type: "Moderat", minutes: 55 },
    { type: "Langtur", minutes: 105 }
  ],
  [
    { type: "Lett", minutes: 40 },
    { type: "Intervall", minutes: 45, focus: "3×8 min tempo", instructions: "Oppv 12. 3×8 min s3, 2 min jogg. Nedjogg 8." },
    { type: "Styrke", minutes: 30, focus: "Stabilitet", instructions: "3 runder: step-ups, hoftehev, tåhev, sideplanke." },
    { type: "Moderat", minutes: 55, focus: "Siste 10 raskere" },
    { type: "Langtur", minutes: 110 }
  ],
  [
    { type: "Lett", minutes: 40 },
    { type: "Intervall", minutes: 40, focus: "20 min jevn terskel", instructions: "Oppv 15. 20 min øvre s3. Nedjogg 5–10." },
    { type: "Styrke", minutes: 25 },
    { type: "Moderat", minutes: 55 },
    { type: "Langtur", minutes: 110, focus: "Rolig terreng" }
  ],
  [
    { type: "Lett", minutes: 45 },
    { type: "Intervall", minutes: 42, focus: "6×3 min bakke", instructions: "Som uke 2, litt raskere." },
    { type: "Styrke", minutes: 25 },
    { type: "Moderat", minutes: 55 },
    { type: "Langtur", minutes: 115 }
  ],
  [
    { type: "Lett", minutes: 45 },
    { type: "Intervall", minutes: 45, focus: "4×5 min tempo", instructions: "Hold kontroll, jevn kraft." },
    { type: "Styrke", minutes: 25 },
    { type: "Moderat", minutes: 55 },
    { type: "Langtur", minutes: 120, focus: "Siste 10 min raskere" }
  ]
];

// FASE 3 – Spissing (uke 17–24)
const TEMPLATE_WEEKS_PHASE3: Array<Array<TemplateItem>> = [
  [
    { type: "Lett", minutes: 35, focus: "Restitusjon + mobilitet" },
    { type: "Intervall", minutes: 45, focus: "4×5 min bakke", instructions: "Oppv 12. 4×5 min s3–4, jogg ned." },
    { type: "Styrke", minutes: 20, focus: "Lett eksplosiv", instructions: "2–3 runder: step-ups, tåhev, hoftehev." },
    { type: "Moderat", minutes: 50, focus: "S3 jevnt, siste 10 raskere" },
    { type: "Langtur", minutes: 100, focus: "Terreng/høyde" }
  ],
  [
    { type: "Lett", minutes: 35 },
    { type: "Intervall", minutes: 48, focus: "3×8 min tempo terreng", instructions: "Oppv 12. 3×8 min s3–4." },
    { type: "Styrke", minutes: 20 },
    { type: "Moderat", minutes: 55 },
    { type: "Langtur", minutes: 105 }
  ],
  [
    { type: "Lett", minutes: 35 },
    { type: "Intervall", minutes: 50, focus: "3×10 min tempo", instructions: "2 min jogg mellom." },
    { type: "Styrke", minutes: 20 },
    { type: "Moderat", minutes: 55 },
    { type: "Langtur", minutes: 110 }
  ],
  [
    { type: "Lett", minutes: 35 },
    { type: "Intervall", minutes: 45, focus: "8×3 min", instructions: "1 min jogg mellom. Hold kontrollert høy fart." },
    { type: "Styrke", minutes: 20 },
    { type: "Moderat", minutes: 55 },
    { type: "Langtur", minutes: 115 }
  ],
  [
    { type: "Lett", minutes: 35 },
    { type: "Intervall", minutes: 45, focus: "2×15 min konk.takt", instructions: "Mål fart fra løypeprofil. 3 min jogg mellom." },
    { type: "Styrke", minutes: 20 },
    { type: "Moderat", minutes: 50 },
    { type: "Langtur", minutes: 115, focus: "Test utstyr/ernæring" }
  ],
  [
    { type: "Lett", minutes: 30 },
    { type: "Intervall", minutes: 40, focus: "20 min terskel jevnt" },
    { type: "Styrke", minutes: 20 },
    { type: "Moderat", minutes: 50 },
    { type: "Langtur", minutes: 100 }
  ],
  [
    { type: "Lett", minutes: 30 },
    { type: "Intervall", minutes: 35, focus: "6×2 min lett raskt" },
    { type: "Styrke", minutes: 15, focus: "Mob + aktivering" },
    { type: "Moderat", minutes: 45 },
    { type: "Langtur", minutes: 60 }
  ],
  [
    { type: "Lett", minutes: 25 },
    { type: "Intervall", minutes: 30, focus: "4×3 min lett" },
    { type: "Styrke", minutes: 15 },
    { type: "Moderat", minutes: 40 },
    { type: "Langtur", minutes: 45 }
  ]
];

function generateBlock(template: Array<Array<TemplateItem>>, startMondayISO: string, blockName: string): Entry[] {
  const plan: Entry[] = [];
  for (let w = 0; w < template.length; w++) {
    const week = template[w];
    for (let d = 0; d < week.length; d++) {
      const item = week[d];
      const date = addDays(startMondayISO, d + w * 7);
      plan.push({ id: uid(), date, plannedType: item.type, plannedMinutes: item.minutes, plannedKm: item.km, focus: item.focus, instructions: item.instructions, completed: false, block: blockName, active: true, updatedAt: nowMs() });
    }
  }
  return plan;
}

// Locked generator: start = next Monday, target = Aug 1 of this/next year
function seedLockedFullPlan(): Entry[] {
  const start = mondayOrNext(todayISO());
  const target = nextSkyrunDate();
  const phases: { name: string; tpl: Array<Array<TemplateItem>> }[] = [
    { name: "Fase 1 – Grunnlag", tpl: TEMPLATE_WEEKS_PHASE1 },
    { name: "Fase 2 – Utvikling", tpl: TEMPLATE_WEEKS_PHASE2 },
    { name: "Fase 3 – Spissing", tpl: TEMPLATE_WEEKS_PHASE3 },
  ];

  let cur = start;
  let idx = 0;
  const out: Entry[] = [];
  while (cmpISO(cur, target) <= 0) {
    const phase = phases[idx % phases.length];
    out.push(...generateBlock(phase.tpl, cur, phase.name));
    cur = addDays(cur, phase.tpl.length * 7);
    idx++;
  }
  return out.filter(e => cmpISO(e.date, target) <= 0);
}

// ---------------- Merge & Storage ----------------
function scoreCompleteness(e: Entry) {
  let s = 0; if (e.completed) s += 10; if (e.actualMinutes != null) s += 4; if (e.actualKm != null) s += 3; if (e.rpe != null) s += 2; if (e.notes && e.notes.trim()) s += 1; return s;
}

function dedupeEntries(list: Entry[]): Entry[] {
  const byKey = new Map<string, Entry>();
  for (const e of list) {
    const key = [e.date, e.plannedType, e.plannedMinutes ?? 0, (e.focus ?? '').trim()].join('|');
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, e); continue; }
    const a = scoreCompleteness(prev); const b = scoreCompleteness(e);
    if (b > a || (b === a && (e.updatedAt ?? 0) > (prev.updatedAt ?? 0))) byKey.set(key, e);
  }
  return Array.from(byKey.values()).sort((x, y) => x.date.localeCompare(y.date));
}

function mergeEntries(a: Entry[], b: Entry[]): Entry[] {
  const byId = new Map<string, Entry>();
  for (const e of [...a, ...b]) {
    const prev = byId.get(e.id);
    if (!prev || (e.updatedAt ?? 0) > (prev.updatedAt ?? 0)) byId.set(e.id, e);
  }
  return dedupeEntries(Array.from(byId.values()));
}

const LS_KEY = "training-entries-v5-prod";
const LS_SETTINGS_KEY = "training-app-settings-v1";

function loadLocal(): PersistedDoc | undefined { const raw = localStorage.getItem(LS_KEY); if (!raw) return undefined; try { return JSON.parse(raw) as PersistedDoc; } catch { return undefined; } }
function saveLocal(doc: PersistedDoc) { localStorage.setItem(LS_KEY, JSON.stringify(doc)); }

function loadSettings(): AppSettings { const raw = localStorage.getItem(LS_SETTINGS_KEY); if (!raw) return { goalType: "minutes", goalValue: 180, autoPull: true, pullIntervalSec: 60 }; try { return JSON.parse(raw) as AppSettings; } catch { return { goalType: "minutes", goalValue: 180, autoPull: true, pullIntervalSec: 60 }; } }
function saveSettings(s: AppSettings) { localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify(s)); }

// ---------------- Sync: GitHub Gist only ----------------

type SyncKind = "GitHubGist";
interface GitHubGistSettings { kind: SyncKind; token: string; gistId?: string; filename?: string }

type SyncSettings = GitHubGistSettings;
const LS_SYNC_KEY = "training-sync-settings-v1";

function loadSyncSettings(): SyncSettings { const raw = localStorage.getItem(LS_SYNC_KEY); if (!raw) return { kind: "GitHubGist", token: "", filename: "treningsplan.json" }; try { return JSON.parse(raw) as SyncSettings } catch { return { kind: "GitHubGist", token: "", filename: "treningsplan.json" } } }
function saveSyncSettings(s: SyncSettings) { localStorage.setItem(LS_SYNC_KEY, JSON.stringify(s)); }

async function syncPull(settings: SyncSettings): Promise<PersistedDoc | undefined> {
  const filename = settings.filename || "treningsplan.json";
  if (!settings.gistId || !settings.token) return undefined;
  const res = await fetch(`https://api.github.com/gists/${settings.gistId}`, { headers: { Authorization: `token ${settings.token}` } });
  if (!res.ok) return undefined;
  const data = await res.json();
  const file = data.files?.[filename];
  if (!file?.content) return undefined;
  try { return JSON.parse(file.content) as PersistedDoc } catch { return undefined }
}

async function syncPush(settings: SyncSettings, doc: PersistedDoc): Promise<boolean> {
  const filename = settings.filename || "treningsplan.json";
  if (!settings.token) return false;
  const body = { files: { [filename]: { content: JSON.stringify(doc, null, 2) } }, description: "Treningsplan sync", public: false };
  const endpoint = settings.gistId ? `https://api.github.com/gists/${settings.gistId}` : `https://api.github.com/gists`;
  const method = settings.gistId ? "PATCH" : "POST";
  const res = await fetch(endpoint, { method, headers: { "Content-Type": "application/json", Authorization: `token ${settings.token}` }, body: JSON.stringify(body) });
  if (!res.ok) return false;
  if (!settings.gistId) { const created = await res.json(); saveSyncSettings({ ...settings, gistId: created.id }); }
  return true;
}

// ---------------- Simple Banner ----------------
function Banner({ kind, message, onClose }: { kind: "info" | "success" | "error"; message: string; onClose: () => void }) {
  const cls = kind === "success" ? "bg-green-100 text-green-800 border-green-200" : kind === "error" ? "bg-red-100 text-red-800 border-red-200" : "bg-blue-100 text-blue-800 border-blue-200";
  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${cls}`} role="status">
      <div className="flex items-center justify-between">
        <span>{message}</span>
        <button className="ml-3 text-xs underline" onClick={onClose}>Lukk</button>
      </div>
    </div>
  );
}

// ---------------- Main Component ----------------
export default function TrainingLogApp() {
  const [syncSettings, setSyncSettings] = useState<SyncSettings>(() => loadSyncSettings());
  const [appSettings] = useState<AppSettings>(() => loadSettings());

  const loaded = loadLocal();
  const [entries, setEntries] = useState<Entry[]>(() => (loaded?.entries ?? []).map(e=>({ active: e.active!==false, ...e })));

  const [filterText, setFilterText] = useState("");
  const [syncStatus, setSyncStatus] = useState<string>("");
  const saveTimer = useRef<number | undefined>(undefined);
  const syncTimer = useRef<number | undefined>(undefined);
  const pullTimer = useRef<number | undefined>(undefined);

  // Interactive flags
  const [isPushing, setIsPushing] = useState(false);
  const [isPulling, setIsPulling] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [banner, setBanner] = useState<{ kind: "info" | "success" | "error"; message: string } | null>(null);
  function notify(kind: "info" | "success" | "error", message: string) { setBanner({ kind, message }); window.setTimeout(() => setBanner(null), 3000); }

  const today = todayISO();
  const currentWeekKey = weekKey(new Date(today + "T12:00:00"));

  // Debounced local save
  useEffect(() => {
    const doc: PersistedDoc = { version: SCHEMA_VERSION, entries };
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => saveLocal(doc), 300);
  }, [entries]);

  // Debounced sync push (only when token present)
  useEffect(() => {
    if (!syncSettings.token) return;
    const doc: PersistedDoc = { version: SCHEMA_VERSION, entries };
    if (syncTimer.current) window.clearTimeout(syncTimer.current);
    syncTimer.current = window.setTimeout(async () => {
      setSyncStatus("Synker...");
      const ok = await syncPush(syncSettings, doc);
      setSyncStatus(ok ? "Synk ok" : "Synk feilet");
      setTimeout(() => setSyncStatus(""), 1500);
    }, 800);
  }, [entries, syncSettings]);

  // Periodic pull
  useEffect(() => {
    if (pullTimer.current) window.clearTimeout(pullTimer.current);
    if (appSettings.autoPull && syncSettings.token) {
      const tick = async () => {
        try {
          const remote = await syncPull(syncSettings);
          if (remote?.entries) {
            const merged = mergeEntries(entries, remote.entries);
            if (merged.length !== entries.length || JSON.stringify(merged) !== JSON.stringify(entries)) {
              setEntries(merged); saveLocal({ version: SCHEMA_VERSION, entries: merged }); setSyncStatus("Flettet (auto)"); setTimeout(() => setSyncStatus(""), 1500);
            }
          }
        } catch {}
      };
      const id = window.setInterval(tick, Math.max(10, appSettings.pullIntervalSec) * 1000);
      pullTimer.current = id as unknown as number;
      return () => window.clearInterval(id);
    }
  }, [appSettings.autoPull, appSettings.pullIntervalSec, syncSettings, entries]);

  // Manual pull
  async function pullNow() {
    try {
      setIsPulling(true); setSyncStatus("Henter...");
      const remote = await syncPull(syncSettings);
      if (remote?.entries) { const merged = mergeEntries(entries, remote.entries); setEntries(merged); saveLocal({ version: SCHEMA_VERSION, entries: merged }); setSyncStatus("Flettet"); notify("success", "Hentet og flettet data."); }
      else { setSyncStatus("Ingen ekstern data"); notify("info", "Ingen nye data funnet."); }
    } catch { setSyncStatus("Henting feilet"); notify("error", "Klarte ikke å hente. Sjekk token/Gist."); }
    finally { setIsPulling(false); setTimeout(() => setSyncStatus(""), 1500); }
  }

  // Helpers for overview
  function fmtDateNo(iso: string) { const d = new Date(iso + "T12:00:00"); return d.toLocaleDateString("nb-NO", { weekday: "short", day: "2-digit", month: "short" }); }

  // Week & block groups
  const weekGroupsRaw = useMemo(() => {
    const sorted = entries.slice().sort((a, b) => a.date.localeCompare(b.date));
    const map = new Map<string, Entry[]>();
    for (const e of sorted) { const wk = weekKey(new Date(e.date + "T12:00:00")); const arr = map.get(wk) || []; arr.push(e); map.set(wk, arr); }
    return Array.from(map.entries()).map(([wk, items]) => {
      const first = items[0]?.date ?? today; const last = items[items.length-1]?.date ?? today; const allDone = items.length>0 && items.filter(x=>x.active!==false).every(x=>x.completed); const isPast = cmpISO(last, today) < 0; const isCurrent = wk === currentWeekKey; const isFuture = cmpISO(first, today) > 0; const block = items[0]?.block ?? "Fase"; return { wk, items, first, last, allDone, isPast, isCurrent, isFuture, block };
    });
  }, [entries]);

  // Group by block
  const blockGroups = useMemo(() => {
    const map = new Map<string, typeof weekGroupsRaw>();
    for (const g of weekGroupsRaw) { const arr = map.get(g.block) || []; arr.push(g); map.set(g.block, arr); }
    const blocks = Array.from(map.entries()).map(([block, weeks]) => ({ block, weeks: weeks.sort((a,b)=> a.first.localeCompare(b.first)) }));
    const hasCurrent = (bg: any) => bg.weeks.some((w:any)=>w.isCurrent);
    const isFutureBlock = (bg: any) => bg.weeks[0] && cmpISO(bg.weeks[0].first, today) > 0;
    const isPastBlock = (bg: any) => bg.weeks[bg.weeks.length-1] && cmpISO(bg.weeks[bg.weeks.length-1].last, today) < 0;
    const current = blocks.filter(hasCurrent);
    const future = blocks.filter(b=>!hasCurrent(b) && isFutureBlock(b)).sort((a,b)=> a.weeks[0].first.localeCompare(b.weeks[0].first));
    const past = blocks.filter(b=>!hasCurrent(b) && isPastBlock(b)).sort((a,b)=> b.weeks[0].first.localeCompare(a.weeks[0].first));
    return [...current, ...future, ...past];
  }, [weekGroupsRaw, today]);

  const [collapsedWeek, setCollapsedWeek] = useState<Record<string, boolean>>({});
  const [collapsedBlock, setCollapsedBlock] = useState<Record<string, boolean>>({});

  // charts
  const weeklyAgg = useMemo(() => {
    const map: Record<string, { week: string; planned: number; actual: number; km: number; sessions: number; completed: number }> = {};
    entries.forEach((e) => { const wk = weekKey(new Date(e.date + "T12:00:00")); if (!map[wk]) map[wk] = { week: wk, planned: 0, actual: 0, km: 0, sessions: 0, completed: 0 }; if (e.active !== false) { map[wk].sessions += 1; map[wk].planned += e.plannedMinutes || 0; } map[wk].actual += e.actualMinutes || 0; map[wk].km += e.actualKm || 0; if (e.completed) map[wk].completed += 1; });
    return Object.values(map).sort((a, b) => a.week.localeCompare(b.week));
  }, [entries]);

  const filtered = useMemo(() => {
    const list = entries.slice().sort((a, b) => a.date.localeCompare(b.date));
    if (!filterText.trim()) return list;
    const q = filterText.toLowerCase();
    return list.filter((e) => [e.date, e.plannedType, e.focus, e.notes, e.instructions].filter(Boolean).some((v) => String(v).toLowerCase().includes(q)));
  }, [entries, filterText]);

  function updateEntry(id: string, patch: Partial<Entry>) { setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch, updatedAt: nowMs() } : e))); }
  function clearAll() { if (confirm("Slette alle data lokalt? (Ingen regenerering)")) setEntries([]); }
  function exportCSV() { download("treningsplan.csv", toCSV(entries)); }
  function exportJSON() { download("treningsplan.json", JSON.stringify({ version: SCHEMA_VERSION, entries }, null, 2)); }
  async function importJSON(file: File) { const reader = new FileReader(); reader.onload = () => { try { const data = JSON.parse(String(reader.result)) as PersistedDoc | Entry[]; const doc: PersistedDoc = Array.isArray(data) ? { version: SCHEMA_VERSION, entries: data as Entry[] } : data; const merged = mergeEntries(entries, (doc.entries || []).map((e) => ({ ...e, updatedAt: e.updatedAt ?? nowMs() }))); setEntries(merged); notify("success", "Importert og flettet JSON."); } catch { notify("error", "Kunne ikke importere JSON."); } }; reader.readAsText(file); }

  const compliance = useMemo(() => { const plannedActive = entries.filter(e=>e.active!==false).length; if (plannedActive === 0) return { pct: 0, done: 0, total: 0 }; const done = entries.filter((e) => e.completed && e.active!==false).length; return { pct: Math.round((100 * done) / plannedActive), done, total: plannedActive }; }, [entries]);

  return (
    <div className="min-h-screen w-full bg-neutral-50 p-4 md:p-6">
      <div className="mx-auto max-w-6xl space-y-4 md:space-y-6">
        {banner && (<Banner kind={banner.kind} message={banner.message} onClose={() => setBanner(null)} />)}

        <header className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl md:text-3xl font-semibold">Skyrun – Din plan til 1. aug</h1>
            <p className="text-neutral-600 text-sm md:text-base">Personlig plan (genereres på knapp). Synk kun via GitHub Gist.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={exportCSV}><FileDown className="mr-2 h-4 w-4" /> CSV</Button>
            <Button variant="secondary" onClick={exportJSON}><Download className="mr-2 h-4 w-4" /> JSON</Button>
            <label className="inline-flex items-center">
              <input type="file" accept="application/json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) importJSON(f); }} />
              <Button variant="secondary" asChild><span><Upload className="mr-2 h-4 w-4" /> Importer JSON</span></Button>
            </label>
            <Button variant="destructive" onClick={clearAll}><Trash2 className="mr-2 h-4 w-4" /> Tøm</Button>
          </div>
        </header>

        {entries.length === 0 && (
          <div className="rounded-md border p-3 text-sm bg-amber-50 border-amber-200 text-amber-900">Tom plan. Gå til <b>Plan</b>-fanen og trykk <b>Generer komplett plan</b>.</div>
        )}

        <Tabs defaultValue="registrer">
          <TabsList className="flex flex-wrap">
            <TabsTrigger value="registrer">Registrer</TabsTrigger>
            <TabsTrigger value="okter">Øktbeskrivelse</TabsTrigger>
            <TabsTrigger value="oversikt">Oversikt</TabsTrigger>
            <TabsTrigger value="plan">Plan</TabsTrigger>
            <TabsTrigger value="synk"><Settings className="mr-2 h-4 w-4" /> Synk</TabsTrigger>
          </TabsList>

          {/* Registrer */}
          <TabsContent value="registrer" className="mt-4">
            <Card>
              <CardHeader className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
                <div>
                  <CardTitle>Dine økter</CardTitle>
                  <CardDescription>Ukevis, grupper i faser. Dagens dag er markert. Fullførte dager er grønne. Inaktive økter er grået ut og teller ikke.</CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Search className="h-4 w-4" />
                  <Input placeholder="Søk i dato, type, fokus, notater" value={filterText} onChange={(e) => setFilterText(e.target.value)} />
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-6">
                  {blockGroups.map(({ block, weeks }) => {
                    const bCollapsed = collapsedBlock[block] ?? false;
                    const blockHasCurrent = weeks.some((w)=>w.isCurrent);
                    const blockAllPast = weeks.every((w)=>w.isPast);
                    const blockAllDone = weeks.every((w)=> w.items.every(i=>i.completed || i.active===false));
                    const blockTone = blockAllDone ? 'ring-2 ring-green-300 bg-green-50' : blockHasCurrent ? 'ring-2 ring-amber-300 bg-amber-50' : blockAllPast ? 'bg-neutral-50' : 'bg-white';
                    return (
                      <div key={block} className={`rounded-xl border ${blockTone}`}>
                        <button className="w-full flex items-center justify-between px-3 py-2 border-b text-left" onClick={()=> setCollapsedBlock(p=>({...p, [block]: !bCollapsed}))}>
                          <div className="flex items-center gap-2 font-semibold"><span className={`inline-block ${bCollapsed?'-rotate-90':'rotate-0'}`}>▾</span>{block}</div>
                          <div className="text-sm text-neutral-600">{weeks.length} uker</div>
                        </button>
                        {!bCollapsed && (
                          <div className="space-y-4 p-3">
                            {weeks.map((g)=>{
                              const { wk, items, first, last, isCurrent, isPast } = g;
                              const allDoneOrInactive = items.every(i=>i.completed || i.active===false);
                              const wCollapsed = collapsedWeek[wk] ?? ((isPast && !isCurrent) || allDoneOrInactive);
                              const headerTone = allDoneOrInactive ? 'bg-green-100' : isCurrent ? 'bg-amber-100' : isPast ? 'bg-neutral-100' : 'bg-white';
                              const borderTone = allDoneOrInactive ? 'border-green-300' : isCurrent ? 'border-amber-300' : isPast ? 'border-neutral-200' : 'border-neutral-200';
                              const plannedActive = items.filter(i=>i.active!==false).length;
                              const doneActive = items.filter(i=>i.completed && i.active!==false).length;
                              return (
                                <div key={wk} className={`rounded-lg border ${borderTone} overflow-hidden`}>
                                  <button className={`w-full flex items-center justify-between px-3 py-2 border-b ${headerTone}`} onClick={()=> setCollapsedWeek(p=>({...p, [wk]: !wCollapsed}))}>
                                    <div className="flex items-center gap-2 font-medium"><span className={`inline-block ${wCollapsed?'-rotate-90':'rotate-0'}`}>▾</span>{wk}<span className="ml-2 text-sm text-neutral-700">{fmtDateNo(first)} – {fmtDateNo(last)}</span></div>
                                    <div className="text-sm text-neutral-700">{doneActive}/{plannedActive} økter</div>
                                  </button>
                                  {!wCollapsed && (
                                    <div className="grid grid-cols-1 md:grid-cols-5 gap-2 p-3">
                                      {items.map((e)=>{
                                        const isToday = e.date === today;
                                        const inactive = e.active===false;
                                        return (
                                          <div key={e.id} className={`rounded-md border p-2 ${inactive ? 'bg-neutral-100 opacity-70' : e.completed ? 'bg-green-50 border-green-200' : isToday ? 'bg-amber-50 border-amber-200' : 'hover:bg-neutral-50'}`}>
                                            <div className="flex items-center justify-between gap-2">
                                              <div className="text-xs text-neutral-600">{fmtDateNo(e.date)}</div>
                                              <div className="flex items-center gap-2 text-xs">
                                                <label className="flex items-center gap-1"><Checkbox checked={e.active!==false} onCheckedChange={(v)=> updateEntry(e.id, { active: Boolean(v) })} /> Aktiv</label>
                                                <label className="flex items-center gap-1"><Checkbox checked={!!e.completed} onCheckedChange={(v) => updateEntry(e.id, { completed: Boolean(v) })} /> Gj.ført</label>
                                              </div>
                                            </div>
                                            <div className="mt-1 font-medium text-sm">{e.plannedType} {e.plannedMinutes ? `· ${e.plannedMinutes} min` : ''}</div>
                                            {e.focus && <div className="text-xs text-neutral-600 line-clamp-2">{e.focus}</div>}
                                            {!inactive && (
                                              <>
                                                <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                                                  <Input placeholder="min" type="number" inputMode="numeric" value={e.actualMinutes ?? ""} onChange={(ev) => updateEntry(e.id, { actualMinutes: ev.target.value === "" ? undefined : Number(ev.target.value) })} />
                                                  <Input placeholder="km" type="number" inputMode="decimal" step="0.1" value={e.actualKm ?? ""} onChange={(ev) => updateEntry(e.id, { actualKm: ev.target.value === "" ? undefined : Number(ev.target.value) })} />
                                                  <Input placeholder="RPE" type="number" inputMode="numeric" min={1} max={10} value={e.rpe ?? ""} onChange={(ev) => updateEntry(e.id, { rpe: ev.target.value === "" ? undefined : Number(ev.target.value) })} />
                                                </div>
                                                <Textarea className="mt-2 min-h-[36px]" placeholder="Notat" value={e.notes ?? ""} onChange={(ev) => updateEntry(e.id, { notes: ev.target.value })} />
                                              </>
                                            )}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="mt-3 flex items-center justify-between text-sm text-neutral-700">
                  <div className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4" /><span>{compliance.done} av {compliance.total} gjennomført</span></div>
                  <div className="font-medium">Oppmøte: {compliance.pct}% {syncStatus && `• ${syncStatus}`}</div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Øktbeskrivelse */}
          <TabsContent value="okter" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle>Hva skal gjøres hver dag</CardTitle>
                <CardDescription>Detaljerte beskrivelser av øktene dine. Uker kan minimeres automatisk (fullført/passert) og manuelt.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {weekGroupsRaw.map(({ wk, items, first, last, isPast, isCurrent, allDone }) => {
                    const plannedActive = items.filter(i=>i.active!==false).length;
                    const doneActive = items.filter(i=>i.completed && i.active!==false).length;
                    const allDoneOrInactive = items.every(i=>i.completed || i.active===false);
                    const wCollapsed = collapsedWeek[wk] ?? ((isPast && !isCurrent) || allDoneOrInactive);
                    const headerTone = allDoneOrInactive ? 'bg-green-100' : isCurrent ? 'bg-amber-100' : isPast ? 'bg-neutral-100' : 'bg-white';
                    const borderTone = allDoneOrInactive ? 'border-green-300' : isCurrent ? 'border-amber-300' : isPast ? 'border-neutral-200' : 'border-neutral-200';
                    return (
                      <div key={wk} className={`rounded-lg border ${borderTone} overflow-hidden`}>
                        <button className={`w-full flex items-center justify-between px-3 py-2 border-b ${headerTone}`} onClick={()=> setCollapsedWeek(p=>({...p, [wk]: !wCollapsed}))}>
                          <div className="flex items-center gap-2 font-medium"><span className={`inline-block ${wCollapsed?'-rotate-90':'rotate-0'}`}>▾</span>{wk}<span className="ml-2 text-sm text-neutral-700">{fmtDateNo(first)} – {fmtDateNo(last)}</span></div>
                          <div className="text-sm text-neutral-700">{doneActive}/{plannedActive} økter</div>
                        </button>
                        {!wCollapsed && (
                          <div className="divide-y">
                            {items.map((e) => (
                              <div key={e.id} className={`p-3 ${e.completed ? 'bg-green-50' : e.date===today ? 'bg-amber-50' : ''}`}>
                                <div className="flex items-center justify-between">
                                  <div className="font-medium">{fmtDateNo(e.date)} – {e.plannedType} {e.plannedMinutes ? `· ${e.plannedMinutes} min` : ''}</div>
                                  {e.completed ? <span className="text-xs text-green-700">Fullført</span> : null}
                                </div>
                                {e.focus && <div className="text-sm text-neutral-700 mt-1">Fokus: {e.focus}</div>}
                                {e.instructions && <div className="text-sm text-neutral-800 mt-1 whitespace-pre-wrap">{e.instructions}</div>}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Oversikt */}
          <TabsContent value="oversikt" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle>Rask oversikt</CardTitle>
                <CardDescription>Summert på uke – og utvikling over tid. Planlagt teller kun aktive økter.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-3 mb-4">
                  <div className="rounded-md border p-3"><div className="text-sm text-neutral-600">Aktive planøkter</div><div className="text-3xl font-semibold">{entries.filter(e=>e.active!==false).length}</div></div>
                  <div className="rounded-md border p-3"><div className="text-sm text-neutral-600">Planlagt tid (aktiv)</div><div className="text-3xl font-semibold">{formatMinutes(entries.filter(e=>e.active!==false).reduce((s, e) => s + (e.plannedMinutes || 0), 0))}</div></div>
                  <div className="rounded-md border p-3"><div className="text-sm text-neutral-600">Faktisk tid</div><div className="text-3xl font-semibold">{formatMinutes(entries.reduce((s, e) => s + (e.actualMinutes || 0), 0))}</div></div>
                </div>
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={weeklyAgg}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="week" />
                      <YAxis />
                      <Tooltip />
                      <Line type="monotone" dataKey="planned" />
                      <Line type="monotone" dataKey="actual" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Planredigering + Generering */}
          <TabsContent value="plan" className="mt-4 space-y-4">
            <GeneratePlan entries={entries} setEntries={setEntries} />
            <PlanEditor entries={entries} setEntries={setEntries} />
          </TabsContent>

          {/* Synk – GitHub Gist only */}
          <TabsContent value="synk" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle>Synkronisering (GitHub Gist)</CardTitle>
                <CardDescription>Sett token (personlig tilgang med «gist» scope) og valgfri Gist ID. Tom Gist ID oppretter ny gist.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>GitHub Token</Label>
                    <Input type="password" placeholder="ghp_..." value={syncSettings.token} onChange={(e) => { const next = { ...syncSettings, token: e.target.value }; setSyncSettings(next); saveSyncSettings(next); }} />
                    <p className="text-xs text-neutral-600">Opprett under Developer settings → Personal access tokens (classic), med minst «gist» scope.</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Gist ID (valgfri)</Label>
                    <Input placeholder="f.eks. a1b2c3d4... (tomt = opprett ny)" value={syncSettings.gistId || ""} onChange={(e) => { const next = { ...syncSettings, gistId: e.target.value || undefined }; setSyncSettings(next); saveSyncSettings(next); }} />
                    <Label>Filnavn</Label>
                    <Input value={syncSettings.filename || "treningsplan.json"} onChange={(e) => { const next = { ...syncSettings, filename: e.target.value || "treningsplan.json" }; setSyncSettings(next); saveSyncSettings(next); }} />
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={async()=>{ setIsValidating(true); try { const ok = await syncPull(syncSettings); notify(ok?"success":"error", ok?"Fant gist og kunne lese fil.":"Kunne ikke lese fra gist."); } finally { setIsValidating(false); } }} disabled={isValidating} aria-busy={isValidating}>{isValidating ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Tester...</>) : ("Test tilkobling")}</Button>
                  <Button variant="secondary" onClick={pullNow} disabled={isPulling} aria-busy={isPulling}>{isPulling ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Henter...</>) : ("Hent nå")}</Button>
                  <Button onClick={async () => { try { setIsPushing(true); setSyncStatus("Skyver..."); const ok = await syncPush(syncSettings, { version: SCHEMA_VERSION, entries }); setSyncStatus(ok ? "Skyv ok" : "Skyv feilet"); notify(ok ? "success" : "error", ok ? "Skyv fullført." : "Skyv feilet."); } finally { setIsPushing(false); setTimeout(() => setSyncStatus("") , 1500); } }} disabled={isPushing} aria-busy={isPushing}>{isPushing ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Skyver...</>) : ("Skyv nå")}</Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <footer className="pt-6 text-center text-xs md:text-sm text-neutral-500"><p>Data lagres lokalt og kan synkes via GitHub Gist når token/Gist er satt.</p></footer>
      </div>
    </div>
  );
}

// ---------------- Minimal runtime tests ----------------
(function devTests() {
  try {
    const mon = mondayOrNext("2025-01-01");
    const blkP1 = generateBlock(TEMPLATE_WEEKS_PHASE1, mon, "Fase 1 – Grunnlag");
    console.assert(blkP1.length === 40, "Fase 1 block should generate 40 sessions (5×8)");
    const blkP2 = generateBlock(TEMPLATE_WEEKS_PHASE2, mon, "Fase 2 – Utvikling");
    const blkP3 = generateBlock(TEMPLATE_WEEKS_PHASE3, mon, "Fase 3 – Spissing");
    console.assert(blkP2.length === 40 && blkP3.length === 40, "Fase 2/3 blocks should each be 40 sessions");
    const full = seedLockedFullPlan();
    console.assert(Array.isArray(full) && full.length > 0, "Locked full plan should generate >= 1 session");
    const csv = toCSV(blkP1);
    console.assert(csv.split("\n").length >= 2, "CSV should contain header + rows");
  } catch (e) { console.warn("Dev tests failed:", e); }
})();

// ---------------- Plan Editor ----------------
function PlanEditor({ entries, setEntries }: { entries: Entry[]; setEntries: React.Dispatch<React.SetStateAction<Entry[]>> }) {
  const [weeklyCap, setWeeklyCap] = useState<number>(5); // default: behold 5 pr uke
  const [startISO, setStartISO] = useState<string>(() => todayISO());
  const priority: PlannedType[] = ["Langtur", "Intervall", "Moderat", "Lett", "Styrke"]; // behold i denne rekkefølgen

  function applyCap() {
    setEntries((prev) => {
      const next = prev.map(e => ({ ...e }));
      const weeks: Record<string, Entry[]> = {};
      for (const e of next) {
        if (cmpISO(e.date, startISO) < 0) continue; // bare fra og med start
        const wk = weekKey(new Date(e.date + "T12:00:00"));
        weeks[wk] = weeks[wk] || [];
        weeks[wk].push(e);
      }
      for (const wk of Object.keys(weeks)) {
        const all = weeks[wk].sort((a,b)=>{
          const pa = priority.indexOf(a.plannedType);
          const pb = priority.indexOf(b.plannedType);
          if (pa !== pb) return pa - pb;
          return a.date.localeCompare(b.date);
        });
        all.forEach((e, i) => { e.active = i < weeklyCap; e.updatedAt = nowMs(); });
      }
      return next;
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Rediger plan – antall økter per uke</CardTitle>
        <CardDescription>Deaktiverer automatisk økter etter prioritet fra og med valgt dato. Prioritet (beholdes først): {priority.join(', ')}.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <Label>Startdato for endring</Label>
            <Input type="date" value={startISO} onChange={(e)=> setStartISO(e.target.value)} />
          </div>
          <div>
            <Label>Maks økter per uke</Label>
            <Input type="number" min={1} max={7} value={weeklyCap} onChange={(e)=> setWeeklyCap(Number(e.target.value || 5))} />
          </div>
          <div className="flex items-end">
            <Button onClick={applyCap}>Juster plan</Button>
          </div>
        </div>
        <p className="text-sm text-neutral-600">Tips: Du kan også slå av/på «Aktiv» per økt i Registrer-fanen.</p>
      </CardContent>
    </Card>
  );
}

// ---------------- Generate Plan (locked) ----------------
function GeneratePlan({ entries, setEntries }: { entries: Entry[]; setEntries: React.Dispatch<React.SetStateAction<Entry[]>> }) {
  const [busy, setBusy] = useState(false);

  function doGenerate(replace: boolean) {
    setBusy(true);
    try {
      const seeded = seedLockedFullPlan();
      setEntries((prev) => replace ? seeded : dedupeEntries([...prev, ...seeded]));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Generer komplett plan</CardTitle>
        <CardDescription>Start = førstkommende mandag · Slutt = 1. august (Skyrun) · Faser = 1→2→3</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button onClick={()=> doGenerate(true)} disabled={busy} aria-busy={busy}><RefreshCw className="mr-2 h-4 w-4" /> Generer (erstatt)</Button>
          <Button variant="secondary" onClick={()=> doGenerate(false)} disabled={busy} aria-busy={busy}>Legg til (flett)</Button>
        </div>
        {entries.length>0 && <p className="text-xs text-neutral-600">«Erstatt» skriver ny plan basert på låste datoer. «Legg til» fletter og fjerner dublikater.</p>}
      </CardContent>
    </Card>
  );
}
