import React, { useEffect, useMemo, useRef, useState } from 'react'

// ──────────────────────────────────────────────────────────────
// Konstante (demo trajanja + fiksno stanje)
// ──────────────────────────────────────────────────────────────
const FIXED_START_BALANCE = 2000 // € – nije editabilno
const SEPA_INSTANT_DURATION = 2_000 // demo: ~2s
const SEPA_STANDARD_DURATION = 20_000 // demo: 1 dan ≈ 20s
const SWIFT_DEMO_DURATION = 40_000 // demo: 2 dana ≈ 40s

// SEPA naknade — indikativno:
// - prvi dnevni transfer do 200€ = 0,02€
// - e-kanali: ≤20.000€ = 1,99€, >20.000€ = 25€
// - šalter:   ≤20.000€ = 3,99€, >20.000€ = 50€
function calcSepaFee(amount: number, channel: 'e-bankarstvo' | 'šalter', firstOfDay: boolean) {
  if (firstOfDay && amount <= 200) return 0.02
  if (channel === 'e-bankarstvo') return amount <= 20_000 ? 1.99 : 25
  return amount <= 20_000 ? 3.99 : 50
}

// Util
function formatEUR(n: number) {
  return new Intl.NumberFormat('me-ME', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 }).format(n)
}

function toAccCountry(country: string) {
  const s = (country || '').trim()
  if (s.length < 2) return s
  return s.slice(0, -1) + 'u'
}

function round2(n: number) { return Math.round(n * 100) / 100 }
function formatTime(ms: number) {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const sec = s % 60
  if (m < 60) return `${m} min ${sec}s`
  const h = Math.floor(m / 60)
  const min = m % 60
  if (h < 48) return `${h}h ${min}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

// ──────────────────────────────────────────────────────────────
// SWIFT profili – indikativno (CG tržište): banke + BEN/SHA/OUR
// ──────────────────────────────────────────────────────────────
type SwiftCostOption = 'BEN' | 'SHA' | 'OUR'
type SwiftBank = 'Generic' | 'NLB' | 'CKB' | 'Hipotekarna'

const SWIFT_BANK_PROFILES: Record<
  SwiftBank,
  (amount: number, option: SwiftCostOption) => {
    senderFee: number
    correspondentFee: number
    note?: string
  }
> = {
  Generic: (amount, option) => {
    // tipične flat + posrednik ~25€
    const base = amount <= 1_000 ? 10 : amount <= 20_000 ? 20 : 35
    const correspondent = option === 'OUR' ? 0 : 25
    const sender = base + (option === 'OUR' ? 25 : 0) // OUR pokriva dio troškova trećih
    return { senderFee: round2(sender), correspondentFee: round2(correspondent) }
  },
  NLB: (amount, option) => {
    const pct = option === 'BEN' ? 0.005 : option === 'SHA' ? 0.0075 : 0.01
    const min = option === 'BEN' ? 10 : option === 'SHA' ? 20 : 25
    const sender = Math.max(amount * pct, min)
    const correspondent = option === 'OUR' ? 0 : 25
    return {
      senderFee: round2(sender),
      correspondentFee: round2(correspondent),
      note: option === 'OUR' ? 'OUR pokriva troškove trećih banaka (indikativno do ~50€)' : undefined
    }
  },
  CKB: (amount, option) => {
    const base = Math.max(amount * 0.01, 9)
    const sender = option === 'OUR' ? base + 15 : base
    const correspondent = option === 'OUR' ? 0 : 25
    return { senderFee: round2(sender), correspondentFee: round2(correspondent) }
  },
  Hipotekarna: (amount, option) => {
    let base =
      amount <= 1_000 ? 10 :
      amount <= 5_000 ? 20 :
      amount <= 20_000 ? amount * 0.0035 :
      amount <= 100_000 ? amount * 0.003 : amount * 0.0025
    const sender = option === 'OUR' ? base + 25 : base
    const correspondent = option === 'OUR' ? 0 : 25
    return { senderFee: round2(sender), correspondentFee: round2(correspondent) }
  }
}

function calcSwiftFees(amount: number, bank: SwiftBank, option: SwiftCostOption) {
  const { senderFee, correspondentFee, note } = SWIFT_BANK_PROFILES[bank](amount, option)
  const beneficiaryGets = round2(amount - (option === 'OUR' ? 0 : correspondentFee))
  const senderPaysTotal = round2(amount + senderFee)
  return { senderFee, correspondentFee, beneficiaryGets, senderPaysTotal, note }
}

// ──────────────────────────────────────────────────────────────
// Glavna komponenta
// ──────────────────────────────────────────────────────────────
export default function SepaSwiftSimulator() {
  // Fiksno stanje (prikaz – skidamo kad pošalje, po želji)
  const [balance, setBalance] = useState<number>(FIXED_START_BALANCE)

  // Podesivi parametri (osim stanja)
  const [country, setCountry] = useState<string>('Njemačka')
  const [amountStr, setAmountStr] = useState<string>('250')
  const amount = useMemo(() => {
    if (amountStr.trim()==='') return 0
    const normalized = amountStr.replace(",", ".").replace(/^0+(?=\d)/, '')
    const n = Number(normalized)
    return Number.isFinite(n) ? n:0
  }, [amountStr])
  const [channel, setChannel] = useState<'e-bankarstvo' | 'šalter'>('e-bankarstvo')
  const [firstOfDay, setFirstOfDay] = useState<boolean>(true)
  const [useInstant, setUseInstant] = useState<boolean>(true)

  // SWIFT izbor
  const [swiftBank, setSwiftBank] = useState<SwiftBank>('Generic')
  const [swiftOption, setSwiftOption] = useState<SwiftCostOption>('SHA')

  // Sim stanje
  const [running, setRunning] = useState<boolean>(false)
  const [sepaProgress, setSepaProgress] = useState<number>(0)
  const [swiftProgress, setSwiftProgress] = useState<number>(0)
  const [finished, setFinished] = useState<{ sepa: boolean; swift: boolean }>({ sepa: false, swift: false })

  // Izračun naknada
  const sepaFee = useMemo(() => calcSepaFee(amount, channel, firstOfDay), [amount, channel, firstOfDay])

  const {
    senderFee: swiftSenderFeeCalc,
    correspondentFee: swiftCorrFee,
    beneficiaryGets: swiftBeneficiaryGets,
    senderPaysTotal: swiftSenderPaysTotal,
    note: swiftNote
  } = useMemo(() => calcSwiftFees(amount, swiftBank, swiftOption), [amount, swiftBank, swiftOption])

  // Trajanja
  const sepaDuration = useMemo(() => (useInstant ? SEPA_INSTANT_DURATION : SEPA_STANDARD_DURATION), [useInstant])
  const countryAcc = useMemo(() => toAccCountry(country), [country])

  const swiftDuration = SWIFT_DEMO_DURATION

  const timeSavedMs = useMemo(() => Math.max(swiftDuration - sepaDuration, 0), [sepaDuration, swiftDuration])
  // Ušteda za pošiljaoca: uporedi naknadu pošiljaoca (SWIFT vs SEPA)
  const moneySaved = useMemo(() => Math.max(swiftSenderFeeCalc - sepaFee, 0), [sepaFee, swiftSenderFeeCalc])

  const disabled = amount <= 0 || amount > balance || running

  // Tajmeri
  const sepaTimerRef = useRef<number | null>(null)
  const swiftTimerRef = useRef<number | null>(null)
  const sepaIntervalRef = useRef<number | null>(null);
  const swiftIntervalRef = useRef<number | null>(null);

  const sepaStartRef = useRef<number>(0)
  const swiftStartRef = useRef<number>(0)

  useEffect(() => {
    return () => {
      if (sepaIntervalRef.current) clearInterval(sepaIntervalRef.current);
      if (swiftIntervalRef.current) clearInterval(swiftIntervalRef.current);
      if (sepaTimerRef.current) cancelAnimationFrame(sepaTimerRef.current)
      if (swiftTimerRef.current) cancelAnimationFrame(swiftTimerRef.current)
    }
  }, [])

  const startSimulation = () => {
    if (disabled) return
    if (sepaIntervalRef.current) clearInterval(sepaIntervalRef.current);
    if (swiftIntervalRef.current) clearInterval(swiftIntervalRef.current)
    if (sepaTimerRef.current) cancelAnimationFrame(sepaTimerRef.current);
    if (swiftTimerRef.current) cancelAnimationFrame(swiftTimerRef.current);
    sepaTimerRef.current = null;
    swiftTimerRef.current = null;
    sepaIntervalRef.current = null;
    swiftIntervalRef.current = null;

    setRunning(true)
    setFinished({ sepa: false, swift: false })
    setSepaProgress(0)
    setSwiftProgress(0)

    setBalance((b) => round2(b - amount - sepaFee))

    // (opciono) skini iznos + SEPA fee iz balansa kad šalješ
    // setBalance((b) => round2(b - amount - sepaFee))

    // SEPA progress (interval, da radi i u background tabu)
    sepaStartRef.current = performance.now();
    sepaIntervalRef.current = window.setInterval(() => {
      const elapsed = performance.now() - sepaStartRef.current;
      const progress = Math.min((elapsed / sepaDuration) * 100, 100);
      setSepaProgress(progress);
      if (progress >= 100) {
        clearInterval(sepaIntervalRef.current!);
        sepaIntervalRef.current = null;
        setFinished(f => {
          const next = { ...f, sepa: true };
          if (next.swift) setRunning(false);
          return next;
        });
      }
    }, 100);

    // SWIFT progress (interval)
    swiftStartRef.current = performance.now();
    swiftIntervalRef.current = window.setInterval(() => {
      const elapsed = performance.now() - swiftStartRef.current;
      const progress = Math.min((elapsed / swiftDuration) * 100, 100);
      setSwiftProgress(progress);
      if (progress >= 100) {
        clearInterval(swiftIntervalRef.current!);
        swiftIntervalRef.current = null;
        setFinished(f => {
          const next = { ...f, swift: true };
          if (next.sepa) setRunning(false);
          return next;
        });
      }
    }, 100);
  }

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-[#0b1f3b] to-[#113b7a] text-white px-4 py-8">
      <div className="max-w-7xl mx-auto">
        <Header balance={balance} />

        <div className="grid lg:grid-cols-2 gap-6 mt-6">
          {/* Lijevi panel – kontrole */}
          <div className="bg-white/10 backdrop-blur rounded-2xl p-6 shadow-xl border border-white/10">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/20">⚙️</span>
              Podesi simulaciju
            </h2>

            <div className="space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <Field label="Iznos za slanje">
                  <AmountInput value={amountStr} onChange={setAmountStr} />
                </Field>
                <Field label="Destinacija (SEPA zemlja)">
                  <Select
                    value={country}
                    onChange={setCountry}
                    options={[
                      'Njemačka','Italija','Francuska','Španija','Hrvatska',
                      'Slovenija','Austrija','Holandija','Švedska','Irska'
                    ]}
                  />
                </Field>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <Field label="Kanal SEPA plaćanja">
                  <Segmented value={channel} onChange={(v) => setChannel(v as any)} options={['e-bankarstvo', 'šalter']} />
                </Field>
                <Field label="Prvi dnevni transfer do 200€?">
                  <Toggle value={firstOfDay} onChange={setFirstOfDay} />
                </Field>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <Field label="SEPA način">
                  <Segmented
                    value={useInstant ? 'SCT Inst (≈2s)' : 'SCT standard (1 dan ≈ 20s)'}
                    onChange={(v) => setUseInstant(v.includes('Inst'))}
                    options={['SCT Inst (≈2s)', 'SCT standard (1 dan ≈ 20s)']}
                  />
                </Field>
                <div className="opacity-70 text-sm flex items-center">SWIFT demo: 2 dana ≈ 40 sekundi</div>
              </div>

              {/* SWIFT izbor banke i troškovne opcije */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <Field label="SWIFT banka (profil naknada)">
                  <Select
                    value={swiftBank}
                    onChange={(v) => setSwiftBank(v as SwiftBank)}
                    options={['Generic','NLB','CKB','Hipotekarna']}
                  />
                </Field>
                <Field label="SWIFT troškovna opcija">
                  <Segmented
                    value={swiftOption}
                    onChange={(v) => setSwiftOption(v as SwiftCostOption)}
                    options={['SHA','OUR','BEN']}
                  />
                </Field>
              </div>

              <div className="flex items-center justify-between pt-2">
                <div className="text-sm text-white/80 space-y-0.5">
                  <p>Stanje na računu: <b>{formatEUR(balance)}</b> (početno: {formatEUR(FIXED_START_BALANCE)})</p>
                  <p>SEPA naknada (indikativno): <b>{formatEUR(sepaFee)}</b></p>
                  <p>SWIFT pošiljalac ({swiftOption}): <b>{formatEUR(swiftSenderFeeCalc)}</b></p>
                  {swiftOption !== 'OUR' && (
                    <p>Procjena troškova posrednika/primaoca: <b>{formatEUR(swiftCorrFee)}</b></p>
                  )}
                </div>
                <button
                  onClick={startSimulation}
                  disabled={disabled}
                  className={
                    'rounded-xl px-5 py-3 font-semibold shadow-lg transition-all ' +
                    (disabled ? 'bg-white/20 text-white/60 cursor-not-allowed' : 'bg-white text-[#0b1f3b] hover:scale-[1.02]')
                  }
                >
                  🚀 Pošalji {formatEUR(amount)} u {countryAcc}
                </button>
              </div>

              {amount > balance && (
                <div className="text-rose-200 text-sm">Iznos je veći od stanja na računu.</div>
              )}
            </div>
          </div>

          {/* Desni panel – vizuelna simulacija */}
          <div className="space-y-6">
            <StatusCard
              title={useInstant ? 'SEPA Instant (SCT Inst)' : 'SEPA standard (SCT)'}
              subtitle={useInstant ? 'Demo: ≈2 sekunde – 24/7/365' : 'Demo: 1 dan ≈ 20 sekundi (grafički prikaz)'}
              colorFrom="#30cfd0"
              colorTo="#00ea9c"
              progress={sepaProgress}
              done={finished.sepa || sepaProgress >= 100}
            />

            <StatusCard
              title="SWIFT međunarodni transfer"
              subtitle="Demo: 2 dana ≈ 40 sekundi (grafički prikaz)"
              colorFrom="#9face6"
              colorTo="#74ebd5"
              progress={swiftProgress}
              done={finished.swift || swiftProgress >= 100}
            />

            <SummaryPanel
              amount={amount}
              sepaFee={sepaFee}
              swiftSenderFee={swiftSenderFeeCalc}
              swiftCorrFee={swiftCorrFee}
              swiftOption={swiftOption}
              swiftBeneficiaryGets={swiftBeneficiaryGets}
              swiftSenderPaysTotal={swiftSenderPaysTotal}
              timeSavedMs={timeSavedMs}
              moneySaved={moneySaved}
              balance={balance}
              country={country}
              useInstant={useInstant}
              note={swiftNote}
            />
          </div>
        </div>

        <Footnote />
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────
// UI helpers
// ──────────────────────────────────────────────────────────────
function Header({ balance }: { balance: number }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">SEPA vs SWIFT — interaktivni prikaz</h1>
        <p className="text-white/80 max-w-2xl mt-1">
          Vidi koliko <span className="font-semibold text-white">brže i jeftinije</span> mogu da prođu tvoja plaćanja
          u eurima kroz SEPA — u odnosu na klasični SWIFT.
        </p>
      </div>
      <div className="rounded-xl bg-white/10 px-4 py-2 text-sm ring-1 ring-white/20">
        Stanje: <span className="font-semibold">{formatEUR(balance)}</span>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-sm text-white/80">{label}</div>
      {children}
    </label>
  )
}

function AmountInput({ value, onChange }:{
  value: string; onChange: (s:string)=>void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-xl bg-white/10 px-3 py-2 ring-1 ring-inset ring-white/15 focus-within:ring-white/40">
      <span className="text-white/70">€</span>
      <input
        type="text"
        inputMode="decimal"
        placeholder="0"
        value={value}
        onChange={(e) => {
          // dozvoli samo cifre, tačku i zarez
          const raw = e.target.value
          const cleaned = raw.replace(/[^\d.,]/g, '')
          onChange(cleaned)
        }}
        onBlur={(e) => {
          // na blur normalizuj vodeće nule (npr. 00012 -> 12)
          const normalized = e.target.value.replace(',', '.').replace(/^0+(?=\d)/, '')
          onChange(normalized)
        }}
        className="w-full bg-transparent outline-none placeholder-white/40"
      />
    </div>
  )
}

function Segmented({ value, onChange, options }:{
  value:string; onChange:(v:string)=>void; options:string[];
}) {
  return (
    <div className="flex rounded-xl bg-white/10 p-1 ring-1 ring-inset ring-white/15">
      {options.map((opt) => {
        const active = value === opt
        return (
          <button
            key={opt}
            onClick={() => onChange(opt)}
            className={
              'flex-1 rounded-lg px-3 py-2 text-sm transition-all ' +
              (active ? 'bg-white text-[#0b1f3b] font-semibold' : 'text-white/80 hover:bg-white/5')
            }
          >
            {opt}
          </button>
        )
      })}
    </div>
  )
}

function Toggle({ value, onChange }:{ value:boolean; onChange:(v:boolean)=>void; }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className={
        'relative inline-flex h-9 w-16 items-center rounded-full transition-colors ' +
        (value ? 'bg-white' : 'bg-white/20')
      }
    >
      <span
        className={
          'inline-block h-7 w-7 transform rounded-full bg-[#0b1f3b] transition-transform ' +
          (value ? 'translate-x-8' : 'translate-x-1')
        }
      />
      <span className="absolute -bottom-5 left-0 text-[10px] uppercase tracking-wide text-white/70">
        {value ? 'Da' : 'Ne'}
      </span>
    </button>
  )
}

function Select({ value, onChange, options }:{
  value:string; onChange:(v:string)=>void; options:string[];
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full appearance-none rounded-xl bg-white/10 px-3 py-2 outline-none ring-1 ring-inset ring-white/15 focus:ring-white/40"
      >
        {options.map((o) => (
          <option key={o} value={o} className="bg-[#0b1f3b] text-white">
            {o}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-white/70">▾</span>
    </div>
  )
}

function StatusCard({ title, subtitle, colorFrom, colorTo, progress, done }:{
  title:string; subtitle:string; colorFrom:string; colorTo:string; progress:number; done:boolean;
}) {
  // prikaži jednu decimalu ispod 10%, da ne izgleda kao da "stoji"
  const progressLabel = done ? 'Završeno' : (progress < 10 ? `${progress.toFixed(1)}%` : `${Math.round(progress)}%`)
  return (
    <div className="relative overflow-hidden rounded-2xl bg-white/10 p-6 shadow-xl ring-1 ring-white/10">
      <div
        className="pointer-events-none absolute -top-16 -right-16 h-48 w-48 rounded-full blur-3xl opacity-30"
        style={{ background: `linear-gradient(135deg, ${colorFrom}, ${colorTo})` }}
      />
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">{title}</h3>
          <p className="text-white/80 text-sm">{subtitle}</p>
        </div>
        <span className="text-sm text-white/80">{progressLabel}</span>
      </div>
      <ProgressBar progress={progress} colorFrom={colorFrom} colorTo={colorTo} />
      <div className="mt-3 text-sm text-white/80">
        {done ? (
          <div className="flex items-center gap-2 text-white">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-white text-[#0b1f3b]">✓</span>
            Sredstva su dostupna primaocu.
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <PulseDot colorFrom={colorFrom} colorTo={colorTo} /> Obrada u toku…
          </div>
        )}
      </div>
    </div>
  )
}

function ProgressBar({ progress, colorFrom, colorTo }:{
  progress:number; colorFrom:string; colorTo:string;
}) {
  const visible = progress > 0 && progress < 1 ? 1 : progress // min 1% da bar bude vidljiv
  return (
    <div className="h-3 w-full overflow-hidden rounded-full bg-white/10">
      <div
        className="h-full rounded-full transition-[width] duration-150"
        style={{ width: `${visible}%`, background: `linear-gradient(90deg, ${colorFrom}, ${colorTo})` }}
      />
    </div>
  )
}

function PulseDot({ colorFrom, colorTo }:{ colorFrom:string; colorTo:string; }) {
  return (
    <span
      className="inline-block h-2.5 w-2.5 rounded-full"
      style={{ background: `linear-gradient(90deg, ${colorFrom}, ${colorTo})` }}
    />
  )
}

function SummaryPanel({
  amount, sepaFee,
  swiftSenderFee, swiftCorrFee, swiftOption, swiftBeneficiaryGets, swiftSenderPaysTotal,
  timeSavedMs, moneySaved, balance, country, useInstant, note
}:{
  amount:number; sepaFee:number;
  swiftSenderFee:number; swiftCorrFee:number; swiftOption:SwiftCostOption; swiftBeneficiaryGets:number; swiftSenderPaysTotal:number;
  timeSavedMs:number; moneySaved:number; balance:number; country:string; useInstant:boolean; note?:string;
}) {
  const timeSaved = formatTime(timeSavedMs)
  const sepaLabel = useInstant ? 'SEPA Inst' : 'SEPA (SCT)'
  return (
    <div className="rounded-2xl bg-white/10 p-6 ring-1 ring-white/10">
      <h4 className="text-lg font-semibold mb-3">Rezime</h4>
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="rounded-xl bg-white/5 p-4">
          <StatRow label="Šalješ" value={`${formatEUR(amount)} → ${country}`} />
          <StatRow label={`${sepaLabel} naknada`} value={formatEUR(sepaFee)} />
          <div className="h-[1px] w-full bg-white/10 my-1" />
          <StatRow label={`SWIFT (${swiftOption}) – trošak pošiljaoca`} value={formatEUR(swiftSenderFee)} />
          {swiftOption !== 'OUR' && (
            <StatRow label="Trošak posrednika/primaoca (procjena)" value={formatEUR(swiftCorrFee)} />
          )}
          <StatRow label="Primaocu stiže (SWIFT)" value={formatEUR(swiftBeneficiaryGets)} />
          <StatRow label="Pošiljalac plaća ukupno (SWIFT)" value={formatEUR(swiftSenderPaysTotal)} />
          {note && <p className="text-xs text-white/70 mt-1 italic">* {note}</p>}
        </div>
        <div className="rounded-xl bg-white/5 p-4">
          <StatRow label="Ušteda novca (u odnosu na SWIFT)" value={formatEUR(moneySaved)} positive />
          <StatRow label="Ušteda vremena" value={timeSaved} positive />
          <StatRow label="Novo stanje (prikaz)" value={formatEUR(balance)} />
        </div>
      </div>
      <p className="text-xs text-white/70 mt-3">
        * Sve brojke su indikativne za edukativni prikaz. Stvarne naknade zavise od banke, paketa i opcije BEN/SHA/OUR.
      </p>
    </div>
  )
}

function StatRow({ label, value, positive = false }:{ label:string; value:string; positive?:boolean; }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-white/80 text-sm">{label}</span>
      <span className={'font-semibold ' + (positive ? 'text-emerald-200' : 'text-white')}>{value}</span>
    </div>
  )
}

function Footnote() {
  return (
    <div className="mt-8 text-xs text-white/70 space-y-1">
      <p>SEPA Inst je edukativni prikaz; dostupnost i limiti zavise od banke. Standardni SCT se u praksi izvršava najkasnije sljedeći radni dan. U ovoj simulaciji: Inst ≈ 2s, 1 dan ≈ 20s.</p>
      <p>SWIFT transferi u praksi mogu potrajati više dana u zavisnosti od posrednika i zemlje. U ovoj simulaciji: 2 dana ≈ 40s.</p>
    </div>
  )
}
