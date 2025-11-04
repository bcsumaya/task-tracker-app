import React, { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Calendar as CalendarIcon, Bell, Mic, Upload, Trash2, CheckCircle2, Clock, ListTodo, FileAudio, FileText, Mail, Import } from "lucide-react";

/**
 * CPP Action Items — single-file React app
 * - Track action items with due dates
 * - Desktop reminders (Notification API)
 * - Calendar view toggle
 * - Upload emails / Zoom & Teams notes (txt, vtt, docx/pdf as attachments)
 * - Record voice action items (stored via IndexedDB)
 * - LocalStorage persistence for items
 *
 * Branding: Cal Poly Pomona (CPP) colors per brand site
 *   CPP Green: #005030
 *   CPP Gold:  #FFB81C
 *   Secondary neutrals used sparingly for accessibility
 */

// ---------- Utilities ----------
const LS_KEY = "cpp-action-items:v1" as const

type Source = "manual" | "email" | "zoom" | "teams" | "voice"

type Attachment = {
  id: string
  name: string
  type: string
  size: number
  url?: string // objectURL for previews
}

type Item = {
  id: string
  title: string
  details?: string
  dueAt?: string // ISO datetime
  createdAt: string // ISO date
  completed: boolean
  source: Source
  tags: string[]
  attachments: Attachment[]
  audioId?: string // idb key if voice note
  notified?: boolean // prevent duplicate notifications
}

const uid = () => Math.random().toString(36).slice(2)

function classNames(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ")
}

// ---------- IndexedDB (for audio blobs) ----------
const DB_NAME = "cpp-action-items-db"
const STORE = "audio"

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbSet(key: string, value: Blob) {
  const db = await openDB()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite")
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function idbGet(key: string): Promise<Blob | undefined> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly")
    const req = tx.objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result as Blob | undefined)
    req.onerror = () => reject(req.error)
  })
}

async function idbDel(key: string) {
  const db = await openDB()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite")
    tx.objectStore(STORE).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// ---------- Local storage ----------
function loadItems(): Item[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Item[]
    return parsed
  } catch {
    return []
  }
}

function saveItems(items: Item[]) {
  localStorage.setItem(LS_KEY, JSON.stringify(items))
}

// ---------- Notifications ----------
function requestNotifyPermission() {
  if (!("Notification" in window)) return
  if (Notification.permission === "default") {
    Notification.requestPermission().catch(() => {})
  }
}

function notify(title: string, body?: string) {
  if (!("Notification" in window)) return
  if (Notification.permission === "granted") {
    new Notification(title, { body })
  }
}

// ---------- Calendar helpers ----------
function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}
function endOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0)
}
function addDays(d: Date, days: number) {
  const x = new Date(d)
  x.setDate(d.getDate() + days)
  return x
}
function isSameDay(a?: Date, b?: Date) {
  if (!a || !b) return false
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}
function fmtDate(d?: string) {
  if (!d) return "—"
  const x = new Date(d)
  return x.toLocaleString()
}

// ---------- UI Primitives (tiny shadcn-like) ----------
const Button: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "solid" | "outline" | "ghost"; tone?: "green" | "gold" | "neutral" }> = ({ className, children, variant = "solid", tone = "green", ...rest }) => {
  const toneCls = {
    green: variant === "solid" ? "bg-[#005030] text-white hover:bg-[#063a25]" : variant === "outline" ? "border border-[#005030] text-[#005030] hover:bg-[#f2f7f4]" : "text-[#005030] hover:bg-[#f2f7f4]",
    gold: variant === "solid" ? "bg-[#FFB81C] text-black hover:bg-[#e8a512]" : variant === "outline" ? "border border-[#FFB81C] text-[#333] hover:bg-[#fff5d6]" : "text-[#b07d00] hover:bg-[#fff5d6]",
    neutral: variant === "solid" ? "bg-neutral-900 text-white hover:bg-neutral-800" : variant === "outline" ? "border border-neutral-300 text-neutral-800 hover:bg-neutral-100" : "text-neutral-700 hover:bg-neutral-100",
  }[tone]
  return (
    <button className={classNames("inline-flex items-center gap-2 px-4 py-2 rounded-2xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed", toneCls, className)} {...rest}>{children}</button>
  )
}

const Card: React.FC<{ className?: string, title?: React.ReactNode, actions?: React.ReactNode }> = ({ className, children, title, actions }) => (
  <div className={classNames("rounded-3xl bg-white shadow-sm ring-1 ring-black/5 p-5", className)}>
    {(title || actions) && (
      <div className="mb-3 flex items-center justify-between">
        <div className="font-semibold text-neutral-900">{title}</div>
        <div>{actions}</div>
      </div>
    )}
    {children}
  </div>
)

// ---------- Voice Recorder ----------
const VoiceRecorder: React.FC<{ onSave: (blob: Blob) => Promise<string> }> = ({ onSave }) => {
  const [recording, setRecording] = useState(false)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const mediaRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<BlobPart[]>([])

  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }, [blobUrl])

  const start = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const mr = new MediaRecorder(stream)
    mediaRef.current = mr
    chunksRef.current = []
    mr.ondataavailable = (e) => chunksRef.current.push(e.data)
    mr.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: "audio/webm" })
      const url = URL.createObjectURL(blob)
      setBlobUrl(url)
    }
    mr.start()
    setRecording(true)
  }

  const stop = () => {
    mediaRef.current?.stop()
    mediaRef.current?.stream.getTracks().forEach(t => t.stop())
    setRecording(false)
  }

  const save = async () => {
    if (!blobUrl) return
    const res = await fetch(blobUrl)
    const blob = await res.blob()
    const id = await onSave(blob)
    // keep preview
    alert("Voice note saved to item.")
    setBlobUrl(null)
    return id
  }

  return (
    <Card title={<div className="flex items-center gap-2"><Mic className="w-4 h-4"/> Record voice action</div>}>
      <div className="flex items-center gap-3">
        {!recording ? (
          <Button onClick={start} tone="gold"><Mic className="w-4 h-4"/> Start</Button>
        ) : (
          <Button onClick={stop} tone="gold"><SquareIcon/> Stop</Button>
        )}
        {blobUrl && (
          <>
            <audio controls src={blobUrl} className="h-10"/>
            <Button onClick={save}><FileAudio className="w-4 h-4"/> Attach to new item</Button>
          </>
        )}
        {!("MediaRecorder" in window) && (
          <p className="text-sm text-red-600">Your browser does not support recording.</p>
        )}
      </div>
    </Card>
  )
}

const SquareIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <rect x="6" y="6" width="12" height="12" rx="1"/>
  </svg>
)

// ---------- Import Parsers (basic) ----------
async function parseTextFile(file: File): Promise<Partial<Item>[]> {
  const text = await file.text()
  const lines = text.split(/\r?\n/)
  // Very light heuristic: lines starting with Action, To-do, or checkbox
  const candidates = lines.filter(l => /^(action|to-?do|\s*-\s*\[\s*\])[:\s]/i.test(l.trim()))
  if (candidates.length === 0) return []
  return candidates.map(l => ({ title: l.replace(/^\s*-\s*\[\s*\]\s*/,'').replace(/^(action|to-?do)[:\s]*/i,'').trim() }))
}

function ext(file: File) {
  const m = /\.([a-z0-9]+)$/i.exec(file.name)
  return m?.[1].toLowerCase()
}

// ---------- Main App ----------
export default function App() {
  const [items, setItems] = useState<Item[]>(() => loadItems())
  const [view, setView] = useState<"list" | "calendar">("list")
  const [month, setMonth] = useState(() => new Date())

  useEffect(() => {
    saveItems(items)
  }, [items])

  useEffect(() => {
    requestNotifyPermission()
  }, [])

  // Reminder ticker: every 60s check for due items
  useEffect(() => {
    const iv = setInterval(() => {
      const now = new Date()
      setItems(prev => prev.map(it => {
        if (!it.dueAt || it.completed || it.notified) return it
        const due = new Date(it.dueAt)
        if (due <= now) {
          notify(`Due: ${it.title}`, it.details)
          return { ...it, notified: true }
        }
        return it
      }))
    }, 60000)
    return () => clearInterval(iv)
  }, [])

  const upcoming = useMemo(() => items
    .filter(i => i.dueAt && !i.completed)
    .sort((a,b) => new Date(a.dueAt!).getTime() - new Date(b.dueAt!).getTime())
    .slice(0,5)
  , [items])

  // Actions
  const addItem = (p: Partial<Item>) => {
    const it: Item = {
      id: uid(),
      title: p.title?.trim() || "Untitled",
      details: p.details || "",
      dueAt: p.dueAt,
      createdAt: new Date().toISOString(),
      completed: false,
      source: p.source || "manual",
      tags: p.tags || [],
      attachments: p.attachments || [],
      audioId: p.audioId,
    }
    setItems(prev => [it, ...prev])
    if (it.dueAt) {
      setTimeout(() => notify(`Due: ${it.title}`, it.details), Math.max(0, new Date(it.dueAt!).getTime() - Date.now()))
    }
  }
  const toggleDone = (id: string) => setItems(prev => prev.map(i => i.id === id ? { ...i, completed: !i.completed } : i))
  const removeItem = async (id: string) => {
    const target = items.find(i => i.id === id)
    if (target?.audioId) await idbDel(target.audioId).catch(()=>{})
    setItems(prev => prev.filter(i => i.id !== id))
  }

  // Voice: save blob then create new item
  const handleSaveVoice = async (blob: Blob) => {
    const audioId = `audio-${uid()}`
    await idbSet(audioId, blob)
    addItem({ title: "Voice action item", source: "voice", audioId })
    return audioId
  }

  // File uploads
  const onUpload = async (files: File[], source: Source) => {
    for (const f of files) {
      const a: Attachment = { id: uid(), name: f.name, type: f.type || ext(f) || "file", size: f.size }
      // Try to parse text-based files for action lines
      let parsed: Partial<Item>[] = []
      if ((f.type.startsWith("text/") || ["txt", "vtt", "md", "csv"].includes(ext(f) || "")) && f.size < 1_000_000) {
        try { parsed = await parseTextFile(f) } catch {}
      }
      if (parsed.length > 0) {
        parsed.forEach(p => addItem({ ...p, source, attachments: [a] }))
      } else {
        addItem({ title: f.name, details: `${source} attachment`, source, attachments: [a] })
      }
    }
  }

  return (
    <div className="min-h-screen bg-[#F2EEE8]">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-[#005030] text-white border-b border-black/10">
        <div className="mx-auto max-w-6xl px-4 py-3 flex items-center gap-4">
          <div className="shrink-0 flex items-center justify-center w-9 h-9 rounded-xl bg-[#FFB81C] text-black font-extrabold">AI</div>
          <div className="flex-1">
            <h1 className="text-lg sm:text-2xl font-bold tracking-tight flex items-center gap-2">
              Cal Poly Pomona — Action Items
              <span className="text-xs font-medium px-2 py-1 rounded-full bg-white/10">Prototype</span>
            </h1>
            <p className="text-white/80 text-xs">Track deliverables, get reminders, and switch to a calendar overview — with uploads & voice capture.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={() => setView("list")} variant={view === "list" ? "solid" : "outline"} tone="gold"><ListTodo className="w-4 h-4"/> List</Button>
            <Button onClick={() => setView("calendar")} variant={view === "calendar" ? "solid" : "outline"} tone="gold"><CalendarIcon className="w-4 h-4"/> Calendar</Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 space-y-6">
        {/* Quick add + upcoming */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="lg:col-span-2" title={<div className="flex items-center gap-2"><Plus className="w-4 h-4"/> New action item</div>}>
            <QuickAdd onAdd={addItem}/>
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
              <UploadButtons onUpload={onUpload}/>
            </div>
          </Card>

          <Card title={<div className="flex items-center gap-2"><Bell className="w-4 h-4"/> Upcoming</div>}>
            {upcoming.length === 0 ? (
              <p className="text-sm text-neutral-600">No upcoming due dates. Add items with a due date to see them here.</p>
            ) : (
              <ul className="space-y-3">
                {upcoming.map(it => (
                  <li key={it.id} className="flex items-start gap-3">
                    <Clock className="w-4 h-4 mt-1 text-[#005030]"/>
                    <div>
                      <div className="font-medium">{it.title}</div>
                      <div className="text-xs text-neutral-600">Due {fmtDate(it.dueAt)}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {/* Main view */}
        {view === "list" ? (
          <Card title={<div className="flex items-center gap-2"><ListTodo className="w-4 h-4"/> Action items</div>}>
            <ItemList items={items} onToggleDone={toggleDone} onRemove={removeItem}/>
          </Card>
        ) : (
          <Card title={<div className="flex items-center gap-2"><CalendarIcon className="w-4 h-4"/> Calendar</div>} actions={
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setMonth(addDays(month, -30))}>Prev</Button>
              <Button variant="outline" onClick={() => setMonth(new Date())}>Today</Button>
              <Button variant="outline" onClick={() => setMonth(addDays(month, +30))}>Next</Button>
            </div>
          }>
            <Calendar items={items} month={month}/>
          </Card>
        )}

        {/* Voice recorder */}
        <VoiceRecorder onSave={handleSaveVoice}/>
      </main>

      <footer className="py-8 text-center text-xs text-neutral-500">
        Built for CPP using approved colors. This prototype stores data in your browser only.
      </footer>

      <StyleBranding/>
    </div>
  )
}

// ---------- Quick Add ----------
const QuickAdd: React.FC<{ onAdd: (p: Partial<Item>) => void }> = ({ onAdd }) => {
  const [title, setTitle] = useState("")
  const [details, setDetails] = useState("")
  const [dueAt, setDueAt] = useState<string>("")
  const [tags, setTags] = useState<string>("")

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    onAdd({ title, details, dueAt: dueAt || undefined, tags: tags.split(",").map(t => t.trim()).filter(Boolean) })
    setTitle("")
    setDetails("")
    setDueAt("")
    setTags("")
  }

  return (
    <form onSubmit={submit} className="grid grid-cols-1 sm:grid-cols-5 gap-3">
      <input value={title} onChange={e=>setTitle(e.target.value)} placeholder="Action title" className="sm:col-span-2 w-full rounded-xl border border-neutral-300 px-3 py-2"/>
      <input value={details} onChange={e=>setDetails(e.target.value)} placeholder="Notes / details" className="sm:col-span-2 w-full rounded-xl border border-neutral-300 px-3 py-2"/>
      <input type="datetime-local" value={dueAt} onChange={e=>setDueAt(e.target.value)} className="w-full rounded-xl border border-neutral-300 px-3 py-2"/>
      <input value={tags} onChange={e=>setTags(e.target.value)} placeholder="tags (comma-separated)" className="sm:col-span-3 w-full rounded-xl border border-neutral-300 px-3 py-2"/>
      <Button type="submit" className="sm:col-span-2"><Plus className="w-4 h-4"/> Add</Button>
    </form>
  )
}

// ---------- Upload Buttons ----------
const UploadButtons: React.FC<{ onUpload: (files: File[], source: Source) => void }> = ({ onUpload }) => {
  const picker = async (accept: string, source: Source, multiple = true) => {
    const input = document.createElement("input")
    input.type = "file"
    input.accept = accept
    input.multiple = multiple
    input.onchange = () => {
      const files = Array.from(input.files || [])
      if (files.length) onUpload(files, source)
    }
    input.click()
  }

  return (
    <>
      <Button variant="outline" tone="neutral" onClick={() => picker(".eml,.msg,.txt,.pdf,.html", "email")}><Mail className="w-4 h-4"/> Upload email</Button>
      <Button variant="outline" tone="neutral" onClick={() => picker(".txt,.vtt,.srt,.docx,.pdf", "zoom")}><Upload className="w-4 h-4"/> Zoom notes</Button>
      <Button variant="outline" tone="neutral" onClick={() => picker(".txt,.vtt,.srt,.docx,.pdf", "teams")}><Upload className="w-4 h-4"/> Teams notes</Button>
      <Button variant="outline" tone="neutral" onClick={() => picker("*/*", "manual")}><Import className="w-4 h-4"/> Other files</Button>
    </>
  )
}

// ---------- Item List ----------
const ItemList: React.FC<{ items: Item[], onToggleDone: (id: string)=>void, onRemove: (id: string)=>void }> = ({ items, onToggleDone, onRemove }) => {
  const [query, setQuery] = useState("")
  const filtered = useMemo(() => {
    const q = query.toLowerCase()
    return items.filter(i => [i.title, i.details, i.tags.join(" ")].join(" ").toLowerCase().includes(q))
  }, [items, query])

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search" className="w-full rounded-xl border border-neutral-300 px-3 py-2"/>
      </div>
      <ul className="divide-y divide-neutral-200">
        {filtered.length === 0 && (
          <li className="py-8 text-center text-neutral-500">No items yet. Add one above.</li>
        )}
        {filtered.map(it => (
          <li key={it.id} className="py-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <input type="checkbox" checked={it.completed} onChange={()=>onToggleDone(it.id)} className="mt-1 w-4 h-4"/>
              <div>
                <div className={classNames("font-medium", it.completed && "line-through text-neutral-500")}>{it.title}</div>
                <div className="text-sm text-neutral-600">{it.details || <span className="italic text-neutral-400">No notes</span>}</div>
                <div className="text-xs text-neutral-500 flex flex-wrap items-center gap-2 mt-1">
                  {it.dueAt && (<span title="Due date" className="inline-flex items-center gap-1"><Clock className="w-3 h-3"/> {fmtDate(it.dueAt)}</span>)}
                  <span className="inline-flex items-center gap-1">Source: {sourceBadge(it.source)}</span>
                  {it.tags.map(t => (<span key={t} className="px-2 py-0.5 bg-neutral-100 rounded-full">#{t}</span>))}
                </div>
                {it.attachments.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {it.attachments.map(att => (
                      <span key={att.id} className="text-xs px-2 py-1 rounded-full bg-white ring-1 ring-neutral-200 flex items-center gap-1">
                        <FileText className="w-3 h-3"/> {att.name}
                      </span>
                    ))}
                  </div>
                )}
                {it.audioId && <AudioPlayer audioId={it.audioId}/>} 
              </div>
            </div>
            <div className="flex items-center gap-2">
              {!it.completed && (
                <Button tone="green" onClick={()=>onToggleDone(it.id)}><CheckCircle2 className="w-4 h-4"/> Done</Button>
              )}
              <Button variant="outline" tone="neutral" onClick={()=>onRemove(it.id)}><Trash2 className="w-4 h-4"/> Remove</Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function sourceBadge(s: Source) {
  const map: Record<Source, string> = {
    manual: "Manual",
    email: "Email",
    zoom: "Zoom",
    teams: "Teams",
    voice: "Voice",
  }
  return map[s]
}

const AudioPlayer: React.FC<{ audioId: string }> = ({ audioId }) => {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    idbGet(audioId).then(blob => {
      if (blob) setUrl(URL.createObjectURL(blob))
    })
    return () => { if (url) URL.revokeObjectURL(url) }
  }, [audioId])
  if (!url) return null
  return (
    <div className="mt-2 flex items-center gap-2 text-sm text-neutral-700">
      <FileAudio className="w-4 h-4"/> <audio controls src={url} className="h-8"/>
    </div>
  )
}

// ---------- Calendar ----------
const Calendar: React.FC<{ items: Item[], month: Date }> = ({ items, month }) => {
  const first = startOfMonth(month)
  const last = endOfMonth(month)
  const start = addDays(first, -first.getDay()) // week starts Sunday
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i))

  const byDay = useMemo(() => {
    const map = new Map<string, Item[]>()
    for (const it of items) {
      if (!it.dueAt) continue
      const key = new Date(it.dueAt).toDateString()
      const arr = map.get(key) || []
      arr.push(it)
      map.set(key, arr)
    }
    return map
  }, [items])

  return (
    <div>
      <div className="mb-3 font-medium text-neutral-800">{month.toLocaleString(undefined, { month: "long", year: "numeric" })}</div>
      <div className="grid grid-cols-7 gap-2 text-xs text-neutral-500 mb-1">
        {"Sun Mon Tue Wed Thu Fri Sat".split(" ").map(d => <div key={d} className="text-center">{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-2">
        {days.map((d, idx) => {
          const key = d.toDateString()
          const its = byDay.get(key) || []
          const inMonth = d.getMonth() === month.getMonth()
          return (
            <div key={idx} className={classNames("rounded-2xl border p-2 min-h-[96px]", inMonth ? "bg-white border-neutral-200" : "bg-neutral-50 border-neutral-200/50")}
                 style={inMonth ? { boxShadow: "inset 0 2px 0 0 #FFB81C" } : undefined}>
              <div className="flex items-center justify-between">
                <div className={classNames("text-xs font-medium", isSameDay(d, new Date()) && "text-[#005030]")}>{d.getDate()}</div>
                {isSameDay(d, new Date()) && <span className="text-[10px] px-1 rounded bg-[#005030] text-white">Today</span>}
              </div>
              <div className="mt-1 space-y-1">
                {its.slice(0,3).map(it => (
                  <div key={it.id} className={classNames("text-[11px] px-2 py-1 rounded-lg", it.completed ? "bg-neutral-100 line-through" : "bg-[#eaf7ef]")}>{it.title}</div>
                ))}
                {its.length > 3 && <div className="text-[10px] text-neutral-500">+{its.length - 3} more</div>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------- Global brand styles ----------
const StyleBranding = () => (
  <style>{`
    :root{
      --cpp-green:#005030; /* CPP Green */
      --cpp-gold:#FFB81C;  /* CPP Gold */
      --cpp-eggshell:#F2EEE8; /* Secondary Eggshell */
    }
    html { scroll-behavior: smooth; }
    body { font-feature-settings: "liga" 1, "kern" 1; }
  `}</style>
)
